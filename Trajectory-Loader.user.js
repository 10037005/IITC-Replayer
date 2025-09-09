// ==UserScript==
// @id             iitc-plugin-trajectory-loader
// @name           Trajectory Loader
// @category       Layer
// @version        1.0.0
// @match          https://intel.ingress.com/*
// @grant          none
// @run-at         document-end
// ==/UserScript==

(function wrapper(plugin_info) {
    if (typeof window.plugin !== 'function') window.plugin = function () {};
    plugin_info.pluginId = 'iitc-plugin-trajectory-loader';
    plugin_info.dateTimeVersion = '20250825';
    plugin_info.buildName = 'beta';

    const PLUGIN_NS = (window.plugin.trajectoryLoader = window.plugin.trajectoryLoader || {});
    const UI = (PLUGIN_NS.ui = PLUGIN_NS.ui || {});
    const STORE = (window._trajectoryStore = window._trajectoryStore || {
        files: [],         // [{name, size, loadedAt}]
        messages: [],      // merged & deduped, sorted ascending by time
        stats: {           // summary
            fileCount: 0,
            rawCount: 0,
            uniqueCount: 0,
            timeStart: null,
            timeEnd: null,
            players: {}      // { playerName: count } - optional pre-aggregation for next steps
        }
    });

    // ---------- Helpers ----------
    // Robust time extractor for IITC parsed messages (support several shapes).
    function getMsgTime(m) {
        // Typical IITC parsed message has 'time' in ms.
        if (typeof m?.time === 'number') return m.time;
        // Some shapes keep timestamp in plext.timestampMs
        if (typeof m?.plext?.timestampMs === 'number') return m.plext.timestampMs;
        // Fallback: try 'ts'
        if (typeof m?.ts === 'number') return m.ts;
        return null;
    }

    // Robust guid extractor (parsed messages should carry guid).
    function getMsgGuid(m) {
        if (typeof m?.guid === 'string') return m.guid;
        if (typeof m?.plext?.guid === 'string') return m.plext.guid;
        return null;
    }

    // Tiny non-crypto hash to build a stable fallback key if guid is missing.
    function tinyHash(str) {
        let h = 2166136261 >>> 0; // FNV-like
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        return (h >>> 0).toString(36);
    }

    // Build dedup key: prefer guid+time; fall back to hash(JSON).
    function buildKey(m) {
        const t = getMsgTime(m);
        const g = getMsgGuid(m);
        if (g && typeof t === 'number') return `${g}|${t}`;
        if (typeof t === 'number') return `t|${t}|${tinyHash(JSON.stringify(m))}`;
        return `x|${tinyHash(JSON.stringify(m))}`;
    }

    // Hints for player name extraction (best-effort, we’ll refine in Step 2).
    function getPlayerName(m) {
        if (typeof m?.player === 'string') return m.player;
        if (typeof m?.plext?.plextOwner === 'string') return m.plext.plextOwner;
        // Sometimes in markup as ['PLAYER', {..., plain: 'Name'}]
        if (Array.isArray(m?.markup)) {
            for (const entry of m.markup) {
                if (entry && entry[0] === 'PLAYER' && entry[1]?.plain) return entry[1].plain;
            }
        }
        return null;
    }

    function formatTs(ms) {
        if (typeof ms !== 'number') return 'N/A';
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    // ---- Event model ----
    // type Event = {
    //   ts: number;
    //   type: 'capture' | 'deploy' | 'link';
    //   player: string;
    //   portals: { guid?: string; lat: number; lng: number; name?: string }[]; // capture/deploy: 1; link: 2
    //   raw: any;
    // };

    function normLatLngFromE6(latE6, lngE6) {
        if (typeof latE6 === 'number' && typeof lngE6 === 'number') {
            return { lat: latE6 / 1e6, lng: lngE6 / 1e6 };
        }
        return null;
    }

    function extractPortalsFromMarkup(markup) {
        // returns array of { guid?, lat, lng, name? }
        const out = [];
        if (!Array.isArray(markup)) return out;
        for (const entry of markup) {
            if (!entry || entry[0] !== 'PORTAL') continue;
            const p = entry[1] || {};
            const norm = normLatLngFromE6(p.latE6, p.lngE6);
            if (!norm) continue;
            out.push({
                guid: typeof p.guid === 'string' ? p.guid : undefined,
                lat: norm.lat,
                lng: norm.lng,
                name: typeof p.name === 'string' ? p.name : undefined,
            });
        }
        return out;
    }

    function extractTextFromMarkup(markup) {
        // concat TEXT/plain in lowercase for simple keyword checks
        if (!Array.isArray(markup)) return '';
        let s = '';
        for (const entry of markup) {
            if (entry && entry[0] === 'TEXT' && entry[1]?.plain) {
                s += entry[1].plain.toLowerCase();
            }
        }
        return s;
    }

    function extractEventFromMessage(m) {
        // returns Event or null if not spatial/irrelevant
        const ts = getMsgTime(m);
        if (typeof ts !== 'number') return null;

        const player = getPlayerName(m);
        const portals = extractPortalsFromMarkup(m?.markup);
        if (portals.length === 0) return null; // no spatial anchor

        const text = extractTextFromMarkup(m?.markup);
        // Decide type: prefer # of portals + keywords as hints
        let type = null;
        if (portals.length >= 2 && text.includes('linked')) {
            type = 'link';
            // keep at most 2 endpoints
            if (portals.length > 2) portals.length = 2;
            if (portals.length < 2) return null; // malformed link
        } else if (text.includes('captured')) {
            type = 'capture';
            portals.length = 1;
        } else if (text.includes('deployed a resonator on')) {
            type = 'deploy';
            portals.length = 1;
        } else {
            return null;
        }

        return {
            ts,
            type,
            player: player || 'UNKNOWN',
            portals,
            raw: m,
        };
    }

    function buildPlayerIndex(events) {
        // Returns { byName: { [player]: { count, byType, firstTs, lastTs } }, allPlayers: string[] }
        const byName = {};
        for (const ev of events) {
            const name = ev.player || 'UNKNOWN';
            const rec = byName[name] || (byName[name] = {
                count: 0,
                byType: { capture: 0, deploy: 0, link: 0 },
                firstTs: ev.ts,
                lastTs: ev.ts,
            });
            rec.count += 1;
            if (rec.byType[ev.type] != null) rec.byType[ev.type] += 1;
            if (ev.ts < rec.firstTs) rec.firstTs = ev.ts;
            if (ev.ts > rec.lastTs) rec.lastTs = ev.ts;
        }
        const allPlayers = Object.keys(byName).sort((a, b) => byName[b].count - byName[a].count);
        return { byName, allPlayers };
    }

    // ---- Track helpers ----

    // get the spatial anchor of an event according to rules:
    // - link: use the FIRST portal as operation location
    // - capture/deploy: use the single portal
    function getEventAnchor(ev) {
        if (!ev || !Array.isArray(ev.portals) || ev.portals.length === 0) return null;
        // Remark 2: for 'link', use the first portal as operation site
        const p = ev.portals[0];
        if (typeof p?.lat !== 'number' || typeof p?.lng !== 'number') return null;
        return {
            lat: p.lat,
            lng: p.lng,
            name: p.name,
            guid: p.guid
        };
    }

    // consider two portals the "same":
    // - if both have guid -> compare guid
    // - else compare lat/lng within a small epsilon
    function isSamePortal(a, b) {
        if (!a || !b) return false;
        if (a.guid && b.guid) return a.guid === b.guid;
        const eps = 1e-6; // ~0.11m in lat; good enough here
        return Math.abs(a.lat - b.lat) < eps && Math.abs(a.lng - b.lng) < eps;
    }

    function haversineKm(lat1, lng1, lat2, lng2) {
        const toRad = (d) => (d * Math.PI) / 180;
        const R = 6371; // km
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const s1 = Math.sin(dLat / 2);
        const s2 = Math.sin(dLng / 2);
        const a = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    function formatDuration(ms) {
        if (ms <= 0) return '0s';
        const sec = Math.floor(ms / 1000);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const parts = [];
        if (h) parts.push(h + 'h');
        if (m) parts.push(m + 'm');
        if (s || (!h && !m)) parts.push(s + 's');
        return parts.join(' ');
    }

    function formatDateTime(ms) {
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    // ---- Arrow helpers ----
    function bearingDeg(lat1, lng1, lat2, lng2) {
        const toRad = d => d * Math.PI / 180;
        const toDeg = r => r * 180 / Math.PI;
        const φ1 = toRad(lat1), φ2 = toRad(lat2);
        const Δλ = toRad(lng2 - lng1);
        const y = Math.sin(Δλ) * Math.cos(φ2);
        const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }

    function destPoint(lat, lng, distMeters, bearingDegVal) {
        const R = 6371000; // meters
        const δ = distMeters / R;
        const θ = bearingDegVal * Math.PI / 180;
        const φ1 = lat * Math.PI / 180;
        const λ1 = lng * Math.PI / 180;

        const sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1);
        const sinδ = Math.sin(δ), cosδ = Math.cos(δ);

        const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
        const φ2 = Math.asin(sinφ2);
        const y = Math.sin(θ) * sinδ * cosφ1;
        const x = cosδ - sinφ1 * sinφ2;
        const λ2 = λ1 + Math.atan2(y, x);

        return { lat: φ2 * 180 / Math.PI, lng: ((λ2 * 180 / Math.PI + 540) % 360) - 180 };
    }

    // Build two short lines as an arrow head at the end of the segment.
    // scale: meters; angle: degrees from the back-direction.
    function buildArrowHeadCoords(fromPt, toPt, scaleMeters = 16, angle = 28) {
        const brg = bearingDeg(fromPt.lat, fromPt.lng, toPt.lat, toPt.lng);
        // Arrow wings are drawn backwards from end point
        const back = (brg + 180) % 360;
        const left = (back - angle + 360) % 360;
        const right = (back + angle) % 360;

        const leftPt = destPoint(toPt.lat, toPt.lng, scaleMeters, left);
        const rightPt = destPoint(toPt.lat, toPt.lng, scaleMeters, right);

        // Return two line segments [[end, left], [end, right]]
        return [
            [[toPt.lat, toPt.lng], [leftPt.lat, leftPt.lng]],
            [[toPt.lat, toPt.lng], [rightPt.lat, rightPt.lng]]
        ];
    }

    // ---------- File reading ----------
    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
            reader.onload = () => resolve(String(reader.result || ''));
            reader.readAsText(file);
        });
    }

    async function loadAndMerge(files, progressCb) {
        const summaries = [];
        const allMessages = [];
        let rawCount = 0;

        // 1) read all files (in parallel)
        const texts = await Promise.all(files.map(readFileAsText));

        // 2) parse and collect messages
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            let parsed;
            try {
                parsed = JSON.parse(texts[i]);
            } catch (e) {
                summaries.push({ name: f.name, ok: false, reason: 'Invalid JSON' });
                progressCb?.(`❌ ${f.name}: invalid JSON`);
                continue;
            }

            const arr = Array.isArray(parsed?.messages) ? parsed.messages : null;
            if (!arr) {
                summaries.push({ name: f.name, ok: false, reason: 'Missing "messages" array' });
                progressCb?.(`❌ ${f.name}: missing "messages" array`);
                continue;
            }

            allMessages.push(...arr);
            rawCount += arr.length;
            summaries.push({ name: f.name, ok: true, count: arr.length });
            progressCb?.(`📦 ${f.name}: ${arr.length} messages`);
        }

        // 3) deduplicate
        const seen = new Set();
        const deduped = [];
        for (const m of allMessages) {
            const key = buildKey(m);
            if (!seen.has(key)) {
                seen.add(key);
                deduped.push(m);
            }
        }

        // 4) sort by time asc
        deduped.sort((a, b) => {
            const ta = getMsgTime(a) ?? 0;
            const tb = getMsgTime(b) ?? 0;
            return ta - tb;
        });

        // 5) compute stats
        const timeStart = getMsgTime(deduped[0]);
        const timeEnd = getMsgTime(deduped[deduped.length - 1]);
        const players = {};
        for (const m of deduped) {
            const p = getPlayerName(m);
            if (p) players[p] = (players[p] || 0) + 1;
        }

        // 6) extract spatial events (capture/deploy/link) and build player index
        const events = [];
        for (const m of deduped) {
            const ev = extractEventFromMessage(m);
            if (ev) events.push(ev);
        }
        // sort events by time asc just in case
        events.sort((a, b) => a.ts - b.ts);

        const { byName: playerIndex, allPlayers } = buildPlayerIndex(events);

        // 7) update global store
        STORE.files = files.map(f => ({ name: f.name, size: f.size, loadedAt: Date.now() }));
        STORE.messages = deduped;             // raw (deduped)
        STORE.events = events;                // normalized spatial events
        STORE.playerIndex = playerIndex;      // { [name]: { count, byType, firstTs, lastTs } }
        STORE.stats = {
            fileCount: files.length,
            rawCount,
            uniqueCount: deduped.length,
            timeStart: timeStart ?? null,
            timeEnd: timeEnd ?? null,
            playersTotal: allPlayers.length,    // number of players with spatial events
        };

        return {
            summaries,
            rawCount,
            uniqueCount: deduped.length,
            timeStart,
            timeEnd,
            playersTotal: allPlayers.length,
            topPlayers: allPlayers.slice(0, 10) // small preview
        };

    }

    // ---- Render / Tracks ----
    const RENDER = (PLUGIN_NS.render = PLUGIN_NS.render || {});

    RENDER.state = {
        layer: null,
        segments: [] // [{fromEv,toEv,fromPt,toPt,polyline,dKm,dtMs,kmh}]
    };

    RENDER.config = {
        strokeColor: '#800080', // purple
        strokeWeight: 3,
        strokeOpacity: 0.9,
        dashArray: '6, 6',
        doubtfulOpacity: 0.4,   // for impossible / flagged segments (reserved)
        maxSpeedKmh: null,       // if set (e.g. 300), segments above will be styled differently
        arrowColor: '#800080',
        arrowWeight: 2,
        arrowOpacity: 0.9,
        arrowScaleMin: 10,   // meters
        arrowScaleMax: 24,   // meters
    };

    // Build contiguous segments for a given player name from STORE.events
    RENDER.buildSegmentsForPlayer = function(playerName) {
        const all = Array.isArray(STORE.events) ? STORE.events : [];
        // filter by player and keep only events with a valid anchor
        const evs = all.filter(ev => (ev.player === playerName) && !!getEventAnchor(ev));
        // sort by time asc (should already be sorted)
        evs.sort((a,b) => a.ts - b.ts);

        const segs = [];
        for (let i = 1; i < evs.length; i++) {
            const prev = evs[i - 1];
            const curr = evs[i];
            const a1 = getEventAnchor(prev);
            const a2 = getEventAnchor(curr);
            if (!a1 || !a2) continue;

            // Remark 1: skip if two adjacent events happened at the SAME portal
            if (isSamePortal(a1, a2)) continue;

            const dKm = haversineKm(a1.lat, a1.lng, a2.lat, a2.lng);
            const dtMs = Math.max(0, curr.ts - prev.ts);
            const kmh = (dtMs > 0 && dKm > 0.08) ? ((dKm - 0.08) / (dtMs / 3600000)) : 0;

            segs.push({
                fromEv: prev,
                toEv: curr,
                fromPt: a1,
                toPt: a2,
                dKm,
                dtMs,
                kmh,
                polyline: null // will be filled when rendering
            });
        }
        return segs;
    };

    // Render segments on map as clickable polylines with popups
    RENDER.renderSegments = function(segments) {
        // init layer group lazily
        if (!RENDER.state.layer) {
            RENDER.state.layer = new L.LayerGroup();
            RENDER.state.layer.addTo(window.map);
        } else {
            RENDER.state.layer.clearLayers();
        }

        const segsOut = [];

        for (const seg of segments) {
            const latlngs = [
                [seg.fromPt.lat, seg.fromPt.lng],
                [seg.toPt.lat, seg.toPt.lng]
            ];

            // style: optionally flag abnormal speed
            const overSpeed = (RENDER.config.maxSpeedKmh && seg.kmh > RENDER.config.maxSpeedKmh);
            const opts = {
                color: RENDER.config.strokeColor,
                weight: RENDER.config.strokeWeight,
                opacity: overSpeed ? RENDER.config.doubtfulOpacity : RENDER.config.strokeOpacity,
                dashArray: RENDER.config.dashArray,
            };

            const pl = L.polyline(latlngs, opts);
            // clickable popup content
            const html =
                  `<div><b>From</b>: ${seg.fromPt.name || '(unknown)'}<br/>` +
                  `&nbsp;&nbsp;Time: ${formatDateTime(seg.fromEv.ts)}</div>` +
                  `<div><b>To</b>&nbsp;&nbsp;&nbsp;: ${seg.toPt.name || '(unknown)'}<br/>` +
                  `&nbsp;&nbsp;Time: ${formatDateTime(seg.toEv.ts)}</div>` +
                  `<hr style="margin:6px 0;"/>` +
                  `<div>Δt: ${formatDuration(seg.dtMs)}</div>` +
                  `<div>Distance: ${seg.dKm.toFixed(3)} km</div>` +
                  `<div> Min Speed: ${( isFinite(seg.kmh) && seg.kmh > 0 ) ? seg.kmh.toFixed(2) : '—'} km/h</div>`;

            pl.bindPopup(html, { maxWidth: 320 });
            pl.addTo(RENDER.state.layer);

            // --- arrow head ---
            // Choose scale based on segment length (shorter line -> smaller arrow)
            const scale = Math.max(
                RENDER.config.arrowScaleMin,
                Math.min(RENDER.config.arrowScaleMax, seg.dKm * 1000 * 0.06) // ~6% of length, clamped
            );
            const arrowLines = buildArrowHeadCoords(seg.fromPt, seg.toPt, scale, 28);
            const arrowOpts = {
                color: RENDER.config.strokeColor,
                weight: RENDER.config.arrowWeight,
                opacity: overSpeed ? RENDER.config.doubtfulOpacity : RENDER.config.arrowOpacity
            };
            const arrow1 = L.polyline(arrowLines[0], arrowOpts).addTo(RENDER.state.layer);
            const arrow2 = L.polyline(arrowLines[1], arrowOpts).addTo(RENDER.state.layer);

            // Keep references for later highlight/clear
            seg.arrow1 = arrow1;
            seg.arrow2 = arrow2;

            seg.polyline = pl;
            segsOut.push(seg);
        }

        RENDER.state.segments = segsOut;
        return segsOut.length;
    };

    // Public API: show track for a player (build + render)
    RENDER.showForPlayer = function(playerName, options = {}) {
        if (!playerName) {
            console.warn('[trajectory-loader] showForPlayer: missing playerName');
            return 0;
        }
        // apply optional overrides
        if (options.maxSpeedKmh != null) RENDER.config.maxSpeedKmh = options.maxSpeedKmh;
        if (options.color) RENDER.config.strokeColor = options.color;
        if (options.weight) RENDER.config.strokeWeight = options.weight;

        const segs = RENDER.buildSegmentsForPlayer(playerName);
        const count = RENDER.renderSegments(segs);
        console.log(`[trajectory-loader] rendered ${count} segment(s) for ${playerName}`);
        return count;
    };

    // Public API: clear current layer
    RENDER.clear = function() {
        if (RENDER.state.layer) RENDER.state.layer.clearLayers();
        RENDER.state.segments = [];
    };

    RENDER.player = {
        timer: null,
        idx: -1,
        playing: false,
        intervalMs: 1200,
        // Playback parameters
        speedScale: 0.02,     // timeline(ms) -> wait(ms) multiplier. e.g. 0.02 = 50x speed
        minDelayMs: 250,      // lower bound per jump so UI feels responsive
        maxDelayMs: 5000,     // upper bound per jump to avoid "stuck for hours"

        highlight(index) {
            const segs = RENDER.state.segments;
            if (!segs || segs.length === 0) return;
            if (index < 0) index = 0;
            if (index >= segs.length) index = segs.length - 1;

            // reset styles
            for (const s of segs) {
                if (s.polyline) s.polyline.setStyle({
                    color: RENDER.config.strokeColor,
                    weight: RENDER.config.strokeWeight,
                    opacity: RENDER.config.strokeOpacity,
                    dashArray: '6,6'
                });
                if (s.arrow1) s.arrow1.setStyle({
                    color: RENDER.config.strokeColor,
                    weight: RENDER.config.arrowWeight,
                    opacity: RENDER.config.arrowOpacity
                });
                if (s.arrow2) s.arrow2.setStyle({
                    color: RENDER.config.strokeColor,
                    weight: RENDER.config.arrowWeight,
                    opacity: RENDER.config.arrowOpacity
                });
            }

            const curr = segs[index];
            if (!curr) return;
            // highlight current (purple solid line, thicker, full opacity)
            curr.polyline.setStyle({
                color: RENDER.config.strokeColor,
                weight: RENDER.config.strokeWeight,
                opacity: 1.0,
                dashArray: null                      // solid line
            });
            curr.arrow1.setStyle({ weight: RENDER.config.arrowWeight + 1, opacity: 1.0 });
            curr.arrow2.setStyle({ weight: RENDER.config.arrowWeight + 1, opacity: 1.0 });

            curr.polyline.bringToFront();
            curr.arrow1.bringToFront();
            curr.arrow2.bringToFront();

            // open popup at mid point
            const midLat = (curr.fromPt.lat + curr.toPt.lat) / 2;
            const midLng = (curr.fromPt.lng + curr.toPt.lng) / 2;
            curr.polyline.openPopup([midLat, midLng]);

            this.idx = index;

            this.idx = index;
            if (this.ui && (this.ui.slider || this.ui.label)) this.updateUI();
        },

        next() {
            const n = (this.idx + 1);
            if (n >= RENDER.state.segments.length) return;
            this.highlight(n);
        },

        prev() {
            const p = (this.idx - 1);
            if (p < 0) return;
            this.highlight(p);
        },

        play() {
            if (this.playing) return;
            const segs = RENDER.state.segments;
            if (!segs || segs.length === 0) return;

            this.playing = true;

            // If not started yet, jump to the first segment and show it.
            if (this.idx < 0) this.idx = 0;
            this.highlight(this.idx);

            // Schedule the next step using time-proportional delay.
            this._scheduleNext();
        },

        // Internal: schedule advancing to next segment with time-proportional wait.
        // The wait is based on the idle gap between the current segment's end time
        // and the next segment's start time. If gap is zero (or negative), we fall
        // back to using the current segment's own duration (dtMs). Finally we clamp
        // with [minDelayMs, maxDelayMs] so the UI never appears "stuck".
        _scheduleNext() {
            if (!this.playing) return;

            const segs = RENDER.state.segments;
            if (!segs || segs.length === 0) return;

            // If this is the last segment, stop playback.
            if (this.idx + 1 >= segs.length) {
                return this.pause();
            }

            const curr = segs[this.idx];
            const next = segs[this.idx + 1];

            // Prefer the timeline "idle" gap between segments, because we skipped
            // same-portal events in rendering and must emulate waiting there.
            const gapMs = Math.max(0, (next.fromEv.ts - curr.toEv.ts));
            const waitMs = this.computeJumpDelayMs(gapMs, curr.dtMs);

            // Use setTimeout (variable delay) instead of setInterval (fixed delay).
            this.timer = setTimeout(() => {
                if (!this.playing) return;
                this.next();           // advances idx and highlights
                this._scheduleNext();  // plan the following jump
            }, waitMs);
        },

        // Compute the actual wait time for the next jump.
        // base = (gapMs > 0 ? gapMs : segDtMs)  -> proportional wait
        // then clamp to [minDelayMs, maxDelayMs]
        computeJumpDelayMs(gapMs, segDtMs) {
            const base = (gapMs && gapMs > 0) ? gapMs : (segDtMs || 0);
            let wait = Math.round(base * this.speedScale);

            if (!isFinite(wait) || wait < this.minDelayMs) wait = this.minDelayMs;
            if (wait > this.maxDelayMs) wait = this.maxDelayMs;

            return wait;
        },

        pause() {
            this.playing = false;
            if (this.timer) clearInterval(this.timer);
            this.timer = null;
        },

        stop() {
            this.pause();
            this.idx = -1;
        },

        // --- UI bindings for quick seek ---
        ui: {
            slider: null, // <input type="range">
            label: null   // <span> like "12 / 87">
        },

        bindUI(sliderEl, labelEl) {
            this.ui.slider = sliderEl || null;
            this.ui.label = labelEl || null;

            if (this.ui.slider) {
                // configure once
                this.ui.slider.min = '0';
                this.ui.slider.step = '1';
                this.ui.slider.disabled = true;

                // drag to seek (pause playback to avoid fight)
                this.ui.slider.oninput = () => {
                    const idx = Number(this.ui.slider.value || 0);
                    this.pause();          // pause while user scrubs
                    this.seek(idx);        // jump & highlight
                };
            }

            this.updateUI(); // initial sync
        },

        // Update slider min/max/value and label text from current segments & idx
        updateUI() {
            const total = (RENDER.state.segments || []).length;
            if (this.ui.slider) {
                this.ui.slider.max = Math.max(0, total - 1).toString();
                this.ui.slider.value = Math.max(0, Math.min(this.idx >= 0 ? this.idx : 0, total - 1)).toString();
                this.ui.slider.disabled = total === 0;
            }
            if (this.ui.label) {
                const cur = total === 0 ? 0 : (this.idx >= 0 ? this.idx + 1 : 1);
                this.ui.label.textContent = `${cur} / ${total}`;
            }
        },

        // Jump to a specific segment index and highlight it
        seek(index) {
            const segs = RENDER.state.segments || [];
            if (segs.length === 0) return;

            let idx = Number(index);
            if (!Number.isFinite(idx)) idx = 0;
            if (idx < 0) idx = 0;
            if (idx >= segs.length) idx = segs.length - 1;

            this.highlight(idx);   // will set this.idx inside
            this.updateUI();
        },

    };

    RENDER.setColor = function (hex) {
        // Basic guard
        if (typeof hex !== 'string' || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
            console.warn('[trajectory-loader] setColor: invalid color:', hex);
            return;
        }
        RENDER.config.strokeColor = hex;

        // Restyle existing layer without rebuilding segments
        const segs = RENDER.state.segments || [];
        for (const s of segs) {
            if (s.polyline) s.polyline.setStyle({
                color: RENDER.config.strokeColor
            });
            if (s.arrow1) s.arrow1.setStyle({
                color: RENDER.config.strokeColor
            });
            if (s.arrow2) s.arrow2.setStyle({
                color: RENDER.config.strokeColor
            });
        }

        // Re-apply highlight styling for the current segment, if any
        if (RENDER.player && RENDER.player.idx >= 0) {
            RENDER.player.highlight(RENDER.player.idx);
        }
        console.log('[trajectory-loader] track color set to', hex);
    };

    // ---------- UI ----------
    UI.open = function openDialog() {
        if (UI._open) return;

        // ─────────────────────────────────────────────────────────────
        // Root container
        // ─────────────────────────────────────────────────────────────
        const container = document.createElement('div');

        // ─────────────────────────────────────────────────────────────
        // Section 1: File loader (label + input + inline Load button)
        // ─────────────────────────────────────────────────────────────
        const fileSection = document.createElement('div');

        const fileLabel = document.createElement('label');
        fileLabel.textContent = 'Select COMM JSON files (multiple):';
        fileLabel.style.display = 'block';
        fileLabel.style.marginBottom = '4px';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.multiple = true;
        fileInput.accept = 'application/json';
        fileInput.style.marginTop = '6px';

        const btnLoadInline = document.createElement('button');
        btnLoadInline.textContent = 'Load Files';
        btnLoadInline.style.display = 'inline-block';
        btnLoadInline.style.marginTop = '8px';

        fileSection.appendChild(fileLabel);
        fileSection.appendChild(fileInput);
        fileSection.appendChild(btnLoadInline);

        // ─────────────────────────────────────────────────────────────
        // Section 2: Summary (numbers) + Progress log (pre)
        // ─────────────────────────────────────────────────────────────
        const summary = document.createElement('div');
        summary.style.marginTop = '10px';

        const pre = document.createElement('pre');
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.maxHeight = '140px';
        pre.style.overflowY = 'auto';
        pre.style.marginTop = '10px';
        pre.textContent = 'Waiting for files...\n';

        function setSummary(res) {
            if (!res) { summary.textContent = ''; return; }
            const { rawCount, uniqueCount, timeStart, timeEnd, playersTotal, topPlayers } = res;
            summary.innerHTML =
                `<div><b>Files:</b> ${STORE.stats.fileCount}</div>` +
                `<div><b>Messages (raw):</b> ${rawCount}</div>` +
                `<div><b>Messages (unique):</b> ${uniqueCount}</div>` +
                `<div><b>Time range:</b> ${formatTs(timeStart)} ~ ${formatTs(timeEnd)}</div>` +
                `<div><b>Players (with spatial events):</b> ${playersTotal}</div>` +
                (topPlayers && topPlayers.length
                 ? `<div><b>Top players:</b> ${topPlayers.join(', ')}</div>`
        : ``);
        }

        // Wire up inline loader
        btnLoadInline.onclick = async () => {
            const files = Array.from(fileInput.files || []);
            if (files.length === 0) {
                pre.textContent += '❗ Please select at least one JSON file.\n';
                return;
            }
            pre.textContent += `\n🚀 Loading ${files.length} file(s)...\n`;
            try {
                const res = await loadAndMerge(files, (msg) => {
                    pre.textContent += msg + '\n';
                    pre.scrollTop = pre.scrollHeight;
                });
                pre.textContent += `\n✅ Done. Unique messages: ${res.uniqueCount}\n`;
                setSummary(res);
                refreshPlayerSelect();                // keep player list in sync
                plugin.trajectoryLoader.render.player.updateUI(); // sync slider counts
            } catch (e) {
                pre.textContent += `\n❌ Error: ${e.message}\n`;
            }
        };

        // ─────────────────────────────────────────────────────────────
        // Section 3: Player select + Render / Clear actions
        // ─────────────────────────────────────────────────────────────
        const actionsRow = document.createElement('div');
        actionsRow.style.marginTop = '12px';

        const playerLabel = document.createElement('label');
        playerLabel.textContent = 'Player:';
        playerLabel.style.display = 'inline-block';
        playerLabel.style.marginRight = '6px';

        const playerSelect = document.createElement('select');
        playerSelect.style.minWidth = '220px';

        function refreshPlayerSelect() {
            const names = STORE.playerIndex ? Object.keys(STORE.playerIndex) : [];
            playerSelect.innerHTML = '';
            names.sort((a, b) => (STORE.playerIndex[b].count - STORE.playerIndex[a].count));
            for (const n of names) {
                const opt = document.createElement('option');
                opt.value = n;
                opt.textContent = `${n} (${STORE.playerIndex[n].count})`;
                playerSelect.appendChild(opt);
            }
        }
        refreshPlayerSelect();

        actionsRow.appendChild(playerLabel);
        actionsRow.appendChild(playerSelect);

        // ─────────────────────────────────────────────────────────────
        // Section 4: Track render and style
        // ─────────────────────────────────────────────────────────────
        const trackRow = document.createElement('div');
        trackRow.style.marginTop = '8px';

        const btnRender = document.createElement('button');
        btnRender.textContent = 'Render Track';
        btnRender.style.height = '28px';

        const btnClear = document.createElement('button');
        btnClear.textContent = 'Clear Track';
        btnClear.style.marginLeft = '6px';
        btnClear.style.height = '28px';

        btnRender.onclick = () => {
            const name = playerSelect.value;
            if (!name) {
                pre.textContent += '❗ Select a player before rendering.\n';
                return;
            }
            const count = plugin.trajectoryLoader.render.showForPlayer(name, { maxSpeedKmh: null });
            pre.textContent += `🎯 Rendered ${count} segment(s) for ${name}.\n`;
            plugin.trajectoryLoader.render.player.updateUI();
        };

        btnClear.onclick = () => {
            plugin.trajectoryLoader.render.clear();
            pre.textContent += '🧹 Cleared track layer.\n';
            plugin.trajectoryLoader.render.player.stop();
            plugin.trajectoryLoader.render.player.updateUI();
        };

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = RENDER.config.strokeColor;
        colorInput.oninput = () => {
            plugin.trajectoryLoader.render.setColor(colorInput.value);
        };
        colorInput.style.marginLeft = '6px'

        trackRow.appendChild(btnRender);
        trackRow.appendChild(btnClear);
        trackRow.appendChild(colorInput);

        // ─────────────────────────────────────────────────────────────
        // Section 5: Playback controls (Prev / Play / Pause / Next)
        // ─────────────────────────────────────────────────────────────
        const playbackRow = document.createElement('div');
        playbackRow.style.marginTop = '8px';

        const btnPrev = document.createElement('button');
        btnPrev.textContent = '<= Prev';
        btnPrev.style.height = '28px';
        btnPrev.onclick = () => plugin.trajectoryLoader.render.player.prev();

        const btnPlay = document.createElement('button');
        btnPlay.textContent = '>> Play';
        btnPlay.style.marginLeft = '6px';
        btnPlay.style.height = '28px';
        btnPlay.onclick = () => plugin.trajectoryLoader.render.player.play();

        const btnPause = document.createElement('button');
        btnPause.textContent = '-- Pause';
        btnPause.style.marginLeft = '6px';
        btnPause.style.height = '28px';
        btnPause.onclick = () => plugin.trajectoryLoader.render.player.pause();

        const btnNext = document.createElement('button');
        btnNext.textContent = 'Next =>';
        btnNext.style.marginLeft = '6px';
        btnNext.style.height = '28px';
        btnNext.onclick = () => plugin.trajectoryLoader.render.player.next();

        playbackRow.appendChild(btnPrev);
        playbackRow.appendChild(btnPlay);
        playbackRow.appendChild(btnPause);
        playbackRow.appendChild(btnNext);

        // ─────────────────────────────────────────────────────────────
        // Section 6: Quick seek (label + range slider)
        // ─────────────────────────────────────────────────────────────
        const seekRow = document.createElement('div');
        seekRow.style.marginTop = '8px';

        const seekLabel = document.createElement('span');
        seekLabel.textContent = '0 / 0';
        seekLabel.style.display = 'inline-block';
        seekLabel.style.minWidth = '72px';
        seekLabel.style.marginRight = '8px';

        const seekSlider = document.createElement('input');
        seekSlider.type = 'range';
        seekSlider.style.width = '240px';

        plugin.trajectoryLoader.render.player.bindUI(seekSlider, seekLabel);

        seekRow.appendChild(seekLabel);
        seekRow.appendChild(seekSlider);

        // ─────────────────────────────────────────────────────────────
        // Compose all sections
        // ─────────────────────────────────────────────────────────────
        container.appendChild(fileSection);
        container.appendChild(summary);
        container.appendChild(pre);
        container.appendChild(actionsRow);
        container.appendChild(trackRow);
        container.appendChild(playbackRow);
        container.appendChild(seekRow);

        // ─────────────────────────────────────────────────────────────
        // Dialog
        // ─────────────────────────────────────────────────────────────
        const dlg = window.dialog({
            html: container,
            title: 'Trajectory Loader',
            id: 'plugin-trajectory-loader',
            dialogClass: 'plugin-trajectory-loader-dialog',
            buttons: {}, // use the "X" to close
            closeCallback: () => { UI._open = false; }
        });

        UI._open = true;
        return dlg;
    };

    function setup() {
        // Add a button to IITC toolbox, consistent with other plugins
        IITC.toolbox.addButton({
            label: 'Trajectory Loader',
            title: 'Load & merge COMM JSON exports',
            action: UI.open
        });
        console.log('[trajectory-loader] ready');
    }

    setup.info = plugin_info;
    if (!window.bootPlugins) window.bootPlugins = [];
    window.bootPlugins.push(setup);
    if (window.iitcLoaded && typeof setup === 'function') setup();


})(/* plugin_info */ {});

