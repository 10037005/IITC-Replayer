// ==UserScript==
// @id             iitc-plugin-replayer
// @name           IITC plugin: Replayer
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

    window.IITC = window.IITC || {};
    IITC.plugin = IITC.plugin || {};
    IITC.plugin.trajectoryLoader = window.plugin.trajectoryLoader;

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

    // Helper: extract player's team from COMM markup.
    // Returns one of 'RESISTANCE' | 'ENLIGHTENED' | 'NEUTRAL' | 'MACHINA' | null
    function extractPlayerTeamFromMarkup(markup) {
        if (!Array.isArray(markup)) return null;

        // Known MACHINA glyph-like name (exact string). A very loose fallback
        // regex is provided in case of diacritic variance; remove it if you
        // prefer strict matching only.
        const MACHINA_PLAIN =
              "_̶̱̍_̴̳͉̆̈́M̷͔̤͒Ą̷̍C̴̼̕ͅH̶̹͕̼̾Ḭ̵̇̾̓N̵̺͕͒̀̍Ä̴̞̰́_̴̦̀͆̓_̷̣̈́";
        const maybeMachina = (s) =>
        s === MACHINA_PLAIN || /M.?A.?C.?H.?I.?N.?A/i.test((s || '').replace(/\p{M}/gu, ''));

        // Prefer PLAYER token if present
        for (const entry of markup) {
            if (entry && entry[0] === 'PLAYER' && entry[1]) {
                const plain = entry[1].plain || '';
                const team = entry[1].team || null;
                if (team === 'NEUTRAL' && maybeMachina(plain)) return 'MACHINA';
                if (team === 'RESISTANCE' || team === 'ENLIGHTENED' || team === 'NEUTRAL') return team;
            }
        }

        // Fallback: some system lines may include a FACTION token for MACHINA
        for (const entry of markup) {
            if (entry && entry[0] === 'FACTION' && entry[1]) {
                const t = entry[1].team;
                if (t === 'MACHINA') return 'MACHINA';
            }
        }

        return null;
    }

    // Helper: extract link's FACTION (color owner) from COMM markup.
    // Returns 'ENLIGHTENED' | 'RESISTANCE' | 'MACHINA' | 'NEUTRAL' | null
    function extractLinkFactionFromMarkup(markup) {
        if (!Array.isArray(markup)) return null;
        for (const entry of markup) {
            if (entry && entry[0] === 'FACTION' && entry[1]?.team) {
                const t = entry[1].team;
                if (t === 'ENLIGHTENED' || t === 'RESISTANCE' || t === 'MACHINA' || t === 'NEUTRAL') {
                    return t;
                }
            }
        }
        return null;
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
        let faction = null; // for link/link_destroyed color owner

        if (portals.length >= 2 && (text.includes(' linked ') || /\blinked\b/.test(text))) {
            type = 'link';
            if (portals.length > 2) portals.length = 2;
            if (portals.length < 2) return null;
            faction = extractLinkFactionFromMarkup(m?.markup) || null;

        } else if (
            portals.length >= 2 &&
            (
                (text.includes(' destroyed ') && text.includes(' link ')) ||
                /destroyed\s+the\s+.*\blink\b/.test(text)
            )
        ) {
            // "Agent X destroyed the <FACTION> Link <PORTAL> to <PORTAL>"
            type = 'link_destroyed';
            if (portals.length > 2) portals.length = 2;
            if (portals.length < 2) return null;
            faction = extractLinkFactionFromMarkup(m?.markup) || null;

        } else if (text.includes('captured')) {
            type = 'capture';
            portals.length = 1;

        } else if (text.includes('deployed a resonator on')) {
            type = 'deploy';
            portals.length = 1;

        } else if (
            (text.includes('destroyed') && text.includes('resonator on')) ||
            /destroyed\s+(?:a|the)?\s*resonator\s+on/.test(text)
        ) {
            type = 'destroy_reso';
            portals.length = 1;

        } else {
            return null;
        }

        const team = extractPlayerTeamFromMarkup(m?.markup) || null;

        // Fallback for link creations without FACTION token:
        // if the PLAYER resolves to MACHINA, treat the link as MACHINA-owned.
        if (type === 'link' && !faction && team === 'MACHINA') {
            faction = 'MACHINA';
        }

        return {
            ts,
            type,
            player: player || 'UNKNOWN',
            portals,
            team,           // 玩家方：仍保留（用于其它用途）
            faction,        // 链路方：新增（仅 link / link_destroyed 有意义）
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
                team: null,
            });
            rec.count += 1;
            if (rec.byType[ev.type] != null) rec.byType[ev.type] += 1;
            if (ev.ts < rec.firstTs) rec.firstTs = ev.ts;
            if (ev.ts > rec.lastTs) rec.lastTs = ev.ts;
            if (!rec.team && ev.team) rec.team = ev.team;
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

    // Weight resolver: fall back to 1.0 when missing
    function _weightOfEventType(type) {
        const map = (RENDER.config && RENDER.config.trajWeightsByType) || {};
        const w = map[type];
        return (typeof w === 'number' && isFinite(w)) ? w : 0.0;
    }

    // Compute weighted centroid of a player's events within [ts - win, ts + win].
    // Uses getEventAnchor(ev) as the spatial point. Returns {lat,lng} or null.
    function weightedCentroidForPlayerAtTs(playerName, ts) {
        const win = RENDER.config.trajSmoothWindowMs || 180000; // 3 min default
        const t0 = ts - win, t1 = ts + win;

        const all = Array.isArray(STORE.events) ? STORE.events : [];
        let sumW = 0, sumLat = 0, sumLng = 0;

        // NOTE: events 已按时间升序（参见 loadAndMerge 的构建）【:contentReference[oaicite:5]{index=5}】
        // 可用简单线性扫描；如需更快可用 STORE.timeline.lowerBound/upperBound 做切片。
        for (let i = 0; i < all.length; i++) {
            const ev = all[i];
            if (!ev || ev.player !== playerName) continue;
            const t = ev.ts;
            if (t < t0) continue;
            if (t > t1) break;

            const anchor = getEventAnchor(ev);
            if (!anchor) continue;

            const w = _weightOfEventType(ev.type);
            if (w <= 0) continue;

            sumW += w;
            sumLat += w * anchor.lat;
            sumLng += w * anchor.lng;
        }

        if (sumW < (RENDER.config.trajMinWeightSum || 0.5)) return null;
        return { lat: sumLat / sumW, lng: sumLng / sumW };
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

    // Build a Leaflet circle as "uncertainty halo" for an event at its anchor.
    function buildUncertaintyHalo(ev) {
        const anchor = getEventAnchor(ev);
        if (!anchor) return null;
        const r = RENDER.config.radiusByType?.[ev.type] ?? 40;
        const color = resolveEventColor(ev);
        return L.circle([anchor.lat, anchor.lng], {
            radius: r,
            color,
            weight: RENDER.config.haloStroke,
            opacity: RENDER.config.haloOpacity,
            dashArray: RENDER.config.haloDashArray,
            fill: true,
            fillOpacity: RENDER.config.haloFillOpacity
        });
    }

    // For link_destroyed later: build halos at both endpoints (if available).
    function buildDualHalosForLink(ev) {
        const pts = Array.isArray(ev.portals) ? ev.portals.slice(0,2) : [];
        if (pts.length < 2) return [];
        const color = resolveEventColor(ev);
        const r = RENDER.config.radiusByType?.link_destroyed ?? 168;
        return pts.map(p => L.circle([p.lat, p.lng], {
            radius: r,
            color,
            weight: RENDER.config.haloStroke,
            opacity: RENDER.config.haloOpacity,
            dashArray: RENDER.config.haloDashArray,
            fill: true,
            fillOpacity: RENDER.config.haloFillOpacity
        }));
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
        // ─────────────────────────────────────────────────────────────
        // Timeline index (sorted events + binary search helpers)
        // ─────────────────────────────────────────────────────────────
        STORE.timeline = {
            events: [], // to be set after files are loaded (sorted ascending by ts)
            lowerBound(ts) { // first idx with e.ts >= ts
                const a = this.events; let lo = 0, hi = a.length;
                while (lo < hi) { const mid = (lo + hi) >> 1; (a[mid].ts < ts) ? (lo = mid + 1) : (hi = mid); }
                return lo;
            },
            upperBound(ts) { // first idx with e.ts > ts
                const a = this.events; let lo = 0, hi = a.length;
                while (lo < hi) { const mid = (lo + hi) >> 1; (a[mid].ts <= ts) ? (lo = mid + 1) : (hi = mid); }
                return lo;
            }
        };
        // after parsing all input files into STORE.events (ascending by ts)
        STORE.timeline.events = (STORE.events || []).slice().sort((a,b)=>a.ts-b.ts);
        if (STORE.timeline.events.length) {
            const evs = STORE.timeline.events;
            RENDER.clock.setRange(evs[0].ts, evs[evs.length-1].ts);
        }

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

    RENDER.flags = {
        useVClock: true,
        showOverviewSegments: false,
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
        colorByTeam: {
            ENLIGHTENED: '#00b000',
            RESISTANCE:  '#007bff',
            MACHINA:     '#cc0000',
            NEUTRAL:     '#808080'
        },
        colorByPlayer: {},
        // Uncertainty halos
        haloStroke: 1.5,
        haloOpacity: 0.35,
        haloFillOpacity: 0.12,
        haloDashArray: '4, 4',
        radiusByType: {  // meters
            capture: 40, deploy: 40, link: 40,
            destroy_reso: 168, link_destroyed: 168
        },
        // Trajectory / segments rendering policy
        showSegmentsInOverview: false,   // 默认关闭：overview 不画整段轨迹
        segWindowPastMs:  10 * 60 * 1000, // 跟随模式/窗口渲染：过去 10 分钟
        segWindowFutureMs: 0 * 60 * 1000,     // 跟随模式/窗口渲染：未来 0 秒
        segShowArrows: false,             // overview 下默认不画箭头（减少对象数）

        // Halos time window：仅显示 [now - past, now + future] 内的事件圈
        haloWindowPastMs:  60 * 1000,   // 过去 1 分钟
        haloWindowFutureMs: 60 * 1000,      // 未来 60 秒

        // Halos 淡出动画（离开窗口时才触发）
        haloFadeDuration: 1200,             // 毫秒
        haloFadeSteps: 6,                   // 离散淡出步数

        // Halos 基础样式（若之前未加）
        haloStroke: 1.5,
        haloOpacity: 0.35,
        haloFillOpacity: 0.12,
        haloDashArray: '4, 4',

        // 半径映射（若之前未加）
        radiusByType: {
            capture: 40, deploy: 40, link: 40,
            destroy_reso: 168, link_destroyed: 168 // 注意：destroy_link 仅用于链生命周期提示，不做位置推断
        },

        // Low-zoom visibility for 40m halos
        haloMinPixelRadius: 12,     // 如果屏幕上的半径 < 12px，则启用低缩放渲染
        haloLowZoomMode: 'marker',  // 'marker' 用 circleMarker 替代；'hide' 直接不画

        // Attack visualization (for destroy_reso)
        attackWindowPastMs: 10 * 60 * 1000,  // find prev 40m event within 10 min (or 250m)
        attackWindowFutureMs: 10 * 60 * 1000, // find next 40m event within 10 min (or 250m)
        attackSpatialThresholdM: 250,        // 250 m
        attackWedgeRadiusM: 40,              // arc radius at portal = 40 m
        attackWedgeMinDeg: 40,               // clamp wedge angle [min, max]
        attackWedgeMaxDeg: 140,
        attackTickLenM: 8,                   // outward normal tick length in meters
        attackTickWidth: 2,                  // px
        attackFadeDuration: 1200,            // ms fade-out when leaving time window
        attackFadeSteps: 6,                  // steps
        attackColorOpacity: 0.22,            // wedge fill opacity
        attackStrokeOpacity: 0.45,           // wedge stroke opacity
        attackRingRadiusM: 10,               // "hit" circle
        attackRingStroke: 2,                 // px
        attackRingPulseScale: 1.2,           // pulse 1.0 -> 1.2 -> 1.0
        attackRingPulseMs: 260,              // pulse one shot
        // Merge logic for many attacks in short time: if new tick angle within X deg of existing tick within Y seconds -> refresh existing instead of new
        attackMergeSecs: 60,
        attackMergeAngleDeg: 20,

        linkStroke: 3,
        linkOpacity: 0.85,
        linkFadeDuration: 800,  // ms
        linkFadeSteps: 5,

        // Playback speed presets (virtual time multiplier)
        speedPresets: [1, 10, 25, 50, 100, 200, 400],
        defaultSpeedIndex: 3, // 0-based index in speedPresets (here: 50×)
        // Trajectory: weighted centroid smoothing
        trajUseWeightedNodes: true,     // 打开后，段的端点用加权平均后的坐标
        trajSmoothWindowMs: 1 * 60 * 1000, // 以节点 ts 为中心 ±1 分钟（可调）
        trajWeightsByType: {           // 事件类型权重
            capture: 1.0,
            deploy: 1.0,
            link: 1.0,
            destroy_reso: 0.15           // 明显小于其它事件
        },
        trajMinWeightSum: 0.5          // 加权窗口里总权重低于该值则退回原始锚点

    };

    // ─────────────────────────────────────────────────────────────
    // Virtual Clock (single source of time)
    // Provides: start/pause/seek/setRange/setSpeed and a subscription API.
    // All render systems should react to time via this clock.
    // ─────────────────────────────────────────────────────────────
    RENDER.clock = (function () {
        let playing = false;
        let t = 0, t0 = 0, tEnd = 0;
        let speed = 50;               // virtual time = real time * speed
        let timer = null;
        const listeners = new Set();  // callbacks: (tPrev:number, tNow:number) => void

        function _tick() {
            const frame = 50; // ms real time per tick (tune later)
            const tPrev = t;
            t = Math.min(t + frame * speed, tEnd);
            // fan-out
            for (const fn of listeners) { try { fn(tPrev, t); } catch (e) { console.warn(e); } }
            if (t >= tEnd) { pause(); return; }
            timer = setTimeout(_tick, frame);
        }

        function start() { if (!playing) { playing = true; _tick(); } }
        function pause() { playing = false; if (timer) clearTimeout(timer); timer = null; }
        function setNow(ts) { t = +ts; for (const fn of listeners) { try { fn(t, t); } catch {} } }
        function seek(ts) { pause(); setNow(ts); } // explicit seek (no drift)
        function setRange(start, end) { t0 = +start; tEnd = +end; if (t < t0) t = t0; }
        function setSpeed(s) { const v = Math.max(1, s|0); speed = v; return v; }

        return {
            start, pause, seek, setNow, setSpeed, setRange,
            on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
            get now() { return t; }, get playing() { return playing; },
            get startTs() { return t0; }, get endTs() { return tEnd; },
            get speed() { return speed; },
        };
    })();

    // Resolve the visual color for a segment:
    // 1) per-player override > 2) team color > 3) global default strokeColor
    function resolveSegmentColor(seg) {
        const cfg = RENDER.config || {};
        const byP = (cfg.colorByPlayer || {});
        const byT = (cfg.colorByTeam || {});
        if (seg && seg.player && byP[seg.player]) return byP[seg.player];
        if (seg && seg.team && byT[seg.team]) return byT[seg.team];
        return cfg.strokeColor;
    }

    // Resolve color for a single event (reuse segment resolver logic).
    function resolveEventColor(ev) {
        return resolveSegmentColor({ player: ev?.player, team: ev?.team });
    }


    // Build contiguous segments for a given player name from STORE.events
    RENDER.buildSegmentsForPlayer = function(playerName) {
        const all = Array.isArray(STORE.events) ? STORE.events : [];
        // filter by player and keep only events with a valid anchor
        const evs = all.filter(ev =>
                               (ev.player === playerName) &&
                               !!getEventAnchor(ev) &&
                               (ev.type === 'capture' || ev.type === 'deploy' || ev.type === 'link' || ev.type === 'destroy_reso')
                              );
        // sort by time asc (should already be sorted)
        evs.sort((a,b) => a.ts - b.ts);

        const segs = [];
        for (let i = 1; i < evs.length; i++) {
            const prev = evs[i - 1];
            const curr = evs[i];
            let a1 = getEventAnchor(prev);
            let a2 = getEventAnchor(curr);
            if (!a1 || !a2) continue;

            // Remark 1: skip if two adjacent events happened at the SAME portal
            if (isSamePortal(a1, a2)) continue;

            // 假设此处已有：const evA = evs[i-1]; const evB = evs[i];（两相邻强事件）

            // 加权端点（若失败回退原始锚点）
            let fromPt = null, toPt = null;
            if (RENDER.config.trajUseWeightedNodes) {
                a1 = weightedCentroidForPlayerAtTs(playerName, prev.ts) || getEventAnchor(prev);
                a2 = weightedCentroidForPlayerAtTs(playerName, curr.ts) || getEventAnchor(curr);
            } else {
                a1 = getEventAnchor(prev);
                a2 = getEventAnchor(curr);
            }
            if (!a1 || !a2) continue; // 防御

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
                player: (curr.player || prev.player || null),
                team: (curr.team || prev.team || null),
                polyline: null // will be filled when rendering
            });
        }
        return segs;
    };

    // Build segments for multiple players, then merge by timeline (ascending).
    RENDER.buildSegmentsForPlayers = function(playerNames) {
        const names = Array.isArray(playerNames) ? playerNames.filter(Boolean) : [];
        if (names.length === 0) return [];

        // Build per-player segments using the existing single-player builder,
        // then concatenate and sort by start time.
        let merged = [];
        for (const name of names) {
            const segs = RENDER.buildSegmentsForPlayer(name) || [];
            // Ensure each segment carries its owner name (added previously)
            for (const s of segs) {
                if (!s.player) s.player = name;
            }
            merged = merged.concat(segs);
        }
        // Sort by the beginning timestamp (fromEv.ts), fallback to toEv.ts
        merged.sort((a, b) => {
            const ta = (a?.fromEv?.ts ?? a?.toEv?.ts ?? 0);
            const tb = (b?.fromEv?.ts ?? b?.toEv?.ts ?? 0);
            return ta - tb;
        });
        return merged;
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
            const color = resolveSegmentColor(seg);
            const opts = {
                color: color,
                weight: RENDER.config.strokeWeight,
                opacity: overSpeed ? RENDER.config.doubtfulOpacity : RENDER.config.strokeOpacity,
                dashArray: RENDER.config.dashArray,
            };

            const pl = L.polyline(latlngs, opts);
            // clickable popup content
            const html =
                  `<div>Δt: ${formatDuration(seg.dtMs)}</div>` +
                  `<div>Distance: ${seg.dKm.toFixed(3)} km</div>` +
                  `<div> Min Speed: ${( isFinite(seg.kmh) && seg.kmh > 0 ) ? seg.kmh.toFixed(2) : '—'} km/h</div>`;

            pl.bindPopup(html, { maxWidth: 320, autoPan: false, closeButton: true });
            pl.addTo(RENDER.state.layer);

            // --- arrow head ---
            // Choose scale based on segment length (shorter line -> smaller arrow)
            const scale = Math.max(
                RENDER.config.arrowScaleMin,
                Math.min(RENDER.config.arrowScaleMax, seg.dKm * 1000 * 0.06) // ~6% of length, clamped
            );
            const arrowLines = buildArrowHeadCoords(seg.fromPt, seg.toPt, scale, 28);
            const arrowOpts = {
                color: color, // arrow color follows segment color
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

    // Render segments for selected players within [now - past, now + future]
    RENDER.renderSegmentsWindowedForPlayers = function(playerNames) {
        const names = Array.isArray(playerNames) ? playerNames.filter(Boolean) : [];
        if (!names.length) { if (RENDER.state.layer) RENDER.state.layer.clearLayers(); return 0; }

        let now = RENDER.clock.now;
        const all = Array.isArray(STORE.events) ? STORE.events : [];
        let minTs = Infinity, maxTs = -Infinity;
        for (const ev of all) {
            if (names.includes(ev.player)) {
                if (ev.ts < minTs) minTs = ev.ts;
                if (ev.ts > maxTs) maxTs = ev.ts;
            }
        }
        if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) {
            if (RENDER.state.layer) RENDER.state.layer.clearLayers();
            return 0;
        }
        // 夹紧到边界：末尾停在 maxTs，起始停在 minTs
        if (!Number.isFinite(now)) now = maxTs;
        if (now < minTs) now = minTs;
        if (now > maxTs) now = maxTs;

        const t0 = now - (RENDER.config.segWindowPastMs || 10*60*1000);
        const t1 = now + (RENDER.config.segWindowFutureMs || 60*1000);

        // 先构建这几名玩家的**全部**段，再裁剪到窗口（已是时间升序）
        let segs = RENDER.buildSegmentsForPlayers(names);
        // 仅显示“已结束”的线段：to.ts <= now；并限制在 [t0, now] 的时间窗内
        segs = segs.filter(s => {
            const a = s?.fromEv?.ts, b = s?.toEv?.ts;
            if (typeof a !== 'number' || typeof b !== 'number') return false;
            if (b > now) return false;                 // 未来段一律不显示
            // 窗口限制：to.ts 落在 [t0, now]（可选：也可用 max(a,t0) <= min(b,now)）
            return (b >= t0 && b <= now);
        });

        // 复用原有渲染器，但按配置禁用箭头（见 B2）
        const old = RENDER.config.segShowArrows;
        RENDER.config.segShowArrows = false;
        const n = RENDER.renderSegments(segs);
        RENDER.config.segShowArrows = old;
        return n;
    };

    // ----------------- SegmentsWindow (windowed segments driven by VClock) -----------------
    RENDER.segmentsWindow = (function () {
        const state = {
            players: [],     // 当前要渲染窗口段的玩家集合
            unsub: null,     // 退订函数
            rafLock: false,  // requestAnimationFrame 节流
        };

        function ensureSubscribed() {
            if (state.unsub) return;
            state.unsub = RENDER.clock.on((tPrev, tNow) => {
                if (!RENDER.config.showSegmentsInOverview) return;
                if (!state.players || state.players.length === 0) return;

                // 用 rAF 做 1 帧节流，避免 20Hz tick 过度清图重绘
                if (state.rafLock) return;
                state.rafLock = true;
                try {
                    requestAnimationFrame(() => {
                        state.rafLock = false;
                        try {
                            RENDER.renderSegmentsWindowedForPlayers(state.players);
                        } catch (e) {
                            console.warn('[trajectory-loader] windowed redraw failed:', e);
                        }
                    });
                } catch (e) {
                    // 在极少数无 rAF 环境退化为直接重绘
                    state.rafLock = false;
                    RENDER.renderSegmentsWindowedForPlayers(state.players);
                }
            });
        }

        return {
            setPlayers(list) {
                state.players = Array.isArray(list) ? list.filter(Boolean) : [];
                if (state.players.length) ensureSubscribed();
            },
            clear() {
                state.players = [];
                // 不强制退订，使控制器常驻；完全销毁可在此调用 state.unsub?.()
            }
        };
    })();

    // ----------------- HaloController (windowed halos driven by VClock) -----------------
    RENDER.halos = (function () {
        const state = {
            layer: null,
            events: [],
            now: null,
            live: new Map(),  // id -> { layer: L.Circle[]|L.Circle, removing?: boolean }
            unsub: null,
            perPlayer: new Map(), // player -> { forty: Event[], destroy: Event[] } (sorted by ts)
            links: new Map(), // key -> { a:{lat,lng,guid}, b:{lat,lng,guid}, faction, bornTs, deadTs, poly?: L.Polyline, removing?:boolean }
        };

        function ensureLayer() {
            if (!state.layer) {
                state.layer = new L.LayerGroup().addTo(window.map);
                try {
                    // 根据缩放刷新圈（重新构建当前窗口内的 halos）
                    window.map.on('zoomend', () => {
                        if (state.now != null) refreshWindow();
                    });
                } catch (e) {}
            }
        }

        function _canonPortalKey(p) {
            return p?.guid ? `g:${p.guid}` : `c:${(p.lat||0).toFixed(6)},${(p.lng||0).toFixed(6)}`;
        }
        function _linkKey(p1, p2) {
            const k1 = _canonPortalKey(p1), k2 = _canonPortalKey(p2);
            return (k1 < k2) ? (k1 + '|' + k2) : (k2 + '|' + k1);
        }
        function _resolveTeamColorByFaction(faction) {
            const map = (RENDER.config?.colorByTeam) || {};
            return map[faction] || '#888888';
        }


        // 事件唯一标识：ts + player + 首门户 guid/坐标 + type
        function eventId(ev) {
            const p = Array.isArray(ev.portals) && ev.portals[0];
            const g = p?.guid || `${p?.lat},${p?.lng}`;
            return `${ev.ts}|${ev.player || 'UNK'}|${ev.type}|${g || 'X'}`;
        }

        // Build a Leaflet circle as "uncertainty halo" for an event at its anchor.
        // 低缩放可见性：当 40m 在屏幕上的像素半径 < haloMinPixelRadius 时，使用 circleMarker 替代或隐藏。
        function buildUncertaintyHalo(ev) {
            const anchor = getEventAnchor(ev);
            if (!anchor) return null;
            const rMeters = RENDER.config.radiusByType?.[ev.type] ?? 40;
            const color = resolveEventColor(ev);

            // 若没有 map 或者未配置 min 像素阈值，则按米半径直接画
            const minPx = Number(RENDER.config.haloMinPixelRadius) || 0;
            if (!window.map || minPx <= 0) {
                return L.circle([anchor.lat, anchor.lng], {
                    radius: rMeters,
                    color,
                    weight: RENDER.config.haloStroke,
                    opacity: RENDER.config.haloOpacity,
                    dashArray: RENDER.config.haloDashArray,
                    fill: true,
                    fillOpacity: RENDER.config.haloFillOpacity
                });
            }

            // 估算当前缩放下，rMeters 对应的屏幕像素半径
            // 取锚点向东 rMeters 的点，算两点在屏幕坐标的距离
            try {
                const dest = destPoint(anchor.lat, anchor.lng, rMeters, 90); // 已有 helper
                const p0 = window.map.latLngToContainerPoint([anchor.lat, anchor.lng]);
                const p1 = window.map.latLngToContainerPoint([dest.lat, dest.lng]);
                const pxRadius = Math.hypot(p1.x - p0.x, p1.y - p0.y);

                if (pxRadius >= minPx) {
                    // 正常画米半径圆
                    return L.circle([anchor.lat, anchor.lng], {
                        radius: rMeters,
                        color,
                        weight: RENDER.config.haloStroke,
                        opacity: RENDER.config.haloOpacity,
                        dashArray: RENDER.config.haloDashArray,
                        fill: true,
                        fillOpacity: RENDER.config.haloFillOpacity
                    });
                } else {
                    // 低缩放处理：marker 或隐藏
                    if ((RENDER.config.haloLowZoomMode || 'marker') === 'marker') {
                        return L.circleMarker([anchor.lat, anchor.lng], {
                            radius: Math.max(4, Math.round(minPx * 0.5)), // 以阈值一半作为像素半径
                            color,
                            weight: RENDER.config.haloStroke,
                            opacity: RENDER.config.haloOpacity,
                            fill: true,
                            fillOpacity: RENDER.config.haloFillOpacity
                        });
                    } else {
                        return null; // 'hide'
                    }
                }
            } catch (e) {
                // 发生异常时回退为米半径圆
                return L.circle([anchor.lat, anchor.lng], {
                    radius: rMeters,
                    color,
                    weight: RENDER.config.haloStroke,
                    opacity: RENDER.config.haloOpacity,
                    dashArray: RENDER.config.haloDashArray,
                    fill: true,
                    fillOpacity: RENDER.config.haloFillOpacity
                });
            }
        }

        // 双端圈（弱提示，仅生命周期）：用于 link_destroyed，如果完全不想画，可让它返回 []
        function buildDualHalosForLink(ev) {
            const pts = Array.isArray(ev.portals) ? ev.portals.slice(0, 2) : [];
            if (pts.length < 2) return [];
            const r = (RENDER.config.radiusByType?.link_destroyed) ?? 168;
            const color = resolveEventColor(ev);
            return pts.map(p => L.circle([p.lat, p.lng], {
                radius: r,
                color,
                weight: (RENDER.config.haloStroke ?? 1.5),
                opacity: (RENDER.config.haloOpacity ?? 0.35),
                dashArray: (RENDER.config.haloDashArray ?? '4, 4'),
                fill: true,
                fillOpacity: (RENDER.config.haloFillOpacity ?? 0.12)
            }));
        }

        // --- geometry helpers for attack visualization ---
        // meters→lat/lng by bearing
        function _destByBearing(lat, lng, bearingDeg, distM) {
            const R = 6378137;
            const br = bearingDeg * Math.PI / 180;
            const dr = distM / R;
            const lat1 = lat * Math.PI / 180;
            const lng1 = lng * Math.PI / 180;
            const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(br));
            const lng2 = lng1 + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
            return { lat: lat2 * 180 / Math.PI, lng: lng2 * 180 / Math.PI };
        }
        function _bearingDeg(from, to) {
            const φ1 = from.lat * Math.PI / 180, φ2 = to.lat * Math.PI / 180;
            const λ1 = from.lng * Math.PI / 180, λ2 = to.lng * Math.PI / 180;
            const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
            const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
            let θ = Math.atan2(y, x) * 180 / Math.PI;
            if (θ < 0) θ += 360;
            return θ; // [0,360)
        }
        function _angularDiff(a, b) {
            let d = Math.abs(a - b) % 360;
            return d > 180 ? 360 - d : d;
        }
        function _buildArcPoints(center, radiusM, startDeg, endDeg, steps) {
            // follow shortest direction from start to end
            let a1 = startDeg, a2 = endDeg;
            let diff = ((a2 - a1 + 540) % 360) - 180; // [-180,180]
            const N = Math.max(3, steps || 14);
            const pts = [];
            for (let i = 0; i <= N; i++) {
                const t = i / N;
                const ang = (a1 + diff * t + 360) % 360;
                pts.push(_destByBearing(center.lat, center.lng, ang, radiusM));
            }
            return pts;
        }

        function _addDestroyVisual(ev) {
            const p0 = Array.isArray(ev.portals) && ev.portals[0];
            if (!p0) return;
            ensureLayer();

            const col = (typeof resolveEventColor === 'function') ? resolveEventColor(ev) : '#ff0000';
            const layers = [];

            // 10m attack ring (mandatory)
            const ring = L.circle([p0.lat, p0.lng], {
                radius: RENDER.config.attackRingRadiusM || 10,
                color: col,
                weight: RENDER.config.attackRingStroke || 2,
                opacity: 0.85,
                fill: true,
                fillOpacity: 0.12
            }).addTo(state.layer);
            layers.push(ring);
            // one-shot pulse
            try {
                const r0 = ring.getRadius();
                const r1 = r0 * (RENDER.config.attackRingPulseScale || 1.2);
                ring.setRadius(r1);
                setTimeout(() => { try { ring.setRadius(r0); } catch {} }, RENDER.config.attackRingPulseMs || 260);
            } catch {}

            // directional arc + outward tick (optional)
            const who = ev.player || '__UNK__';
            const bucket = state.perPlayer.get(who) || { forty: [] };
            const center = { lat: p0.lat, lng: p0.lng };
            const t0 = ev.ts;

            // find prev/next 40m events by time (±attackWindow) OR distance (≤ attackSpatialThresholdM)
            const prev40 = (function () {
                const arr = bucket.forty || [];
                // last index with ts <= t0
                let lo = 0, hi = arr.length;
                while (lo < hi) { const mid = (lo + hi) >> 1; (arr[mid].ts <= t0) ? (lo = mid + 1) : (hi = mid); }
                for (let i = lo - 1; i >= 0; i--) {
                    const e = arr[i]; const a = Array.isArray(e.portals) ? e.portals[0] : null; if (!a) continue;
                    const dt = t0 - e.ts;
                    const dtOk = dt <= (RENDER.config.attackWindowPastMs || 10*60*1000);
                    let dOk = false;
                    try { dOk = window.map.distance([center.lat, center.lng], [a.lat, a.lng]) <= (RENDER.config.attackSpatialThresholdM || 250); } catch {}
                    if (dtOk || dOk) return { anchor: a, ts: e.ts };
                    if (!dtOk) break;
                }
                return null;
            })();
            const next40 = (function () {
                const arr = bucket.forty || [];
                // first index with ts > t0
                let lo = 0, hi = arr.length;
                while (lo < hi) { const mid = (lo + hi) >> 1; (arr[mid].ts <= t0) ? (lo = mid + 1) : (hi = mid); }
                for (let i = lo; i < arr.length; i++) {
                    const e = arr[i]; const a = Array.isArray(e.portals) ? e.portals[0] : null; if (!a) continue;
                    const dt = e.ts - t0;
                    const dtOk = dt <= (RENDER.config.attackWindowFutureMs || 10*60*1000);
                    let dOk = false;
                    try { dOk = window.map.distance([center.lat, center.lng], [a.lat, a.lng]) <= (RENDER.config.attackSpatialThresholdM || 250); } catch {}
                    if (dtOk || dOk) return { anchor: a, ts: e.ts };
                    if (!dtOk) break;
                }
                return null;
            })();

            if (prev40 || next40) {
                const radius = RENDER.config.attackWedgeRadiusM || 40;
                const tickLen = RENDER.config.attackTickLenM || 8;
                const minDeg = RENDER.config.attackWedgeMinDeg || 40;
                const maxDeg = RENDER.config.attackWedgeMaxDeg || 140;

                const θ1 = prev40 ? _bearingDeg(center, prev40.anchor) : null;
                const θ2 = next40 ? _bearingDeg(center, next40.anchor) : null;

                let startDeg, endDeg, midDeg;
                if (θ1 != null && θ2 != null) {
                    let d = ((θ2 - θ1 + 540) % 360) - 180; // [-180,180]
                    const span = Math.min(Math.max(Math.abs(d), minDeg), maxDeg);
                    const sign = d >= 0 ? 1 : -1;
                    startDeg = θ1;
                    endDeg   = (θ1 + sign * span + 360) % 360;
                    midDeg   = (θ1 + sign * (span / 2) + 360) % 360;
                } else {
                    const base = (θ1 != null ? θ1 : θ2);
                    const span = 90;
                    startDeg = (base - span/2 + 360) % 360;
                    endDeg   = (base + span/2 + 360) % 360;
                    midDeg   = base;
                }

                // arc (polyline)
                const arcPts = _buildArcPoints(center, radius, startDeg, endDeg, 14);
                const arc = L.polyline(arcPts, {
                    color: col,
                    weight: 2,
                    opacity: (RENDER.config.attackStrokeOpacity ?? 0.45)
                }).addTo(state.layer);
                layers.push(arc);

                // outward normal tick from arc midpoint
                const midPt = _destByBearing(center.lat, center.lng, midDeg, radius);
                const tipPt = _destByBearing(midPt.lat, midPt.lng, midDeg, tickLen);
                const tick = L.polyline([midPt, tipPt], {
                    color: col,
                    weight: (RENDER.config.attackTickWidth || 2),
                    opacity: (RENDER.config.attackStrokeOpacity ?? 0.45)
                }).addTo(state.layer);
                layers.push(tick);
            }

            return layers; // caller will register into state.live
        }

        function addEv(ev) {
            const id = eventId(ev);
            if (state.live.has(id)) return;

            if (ev.type === 'destroy_reso') {
                const layers = _addDestroyVisual(ev); // returns L layers array (includes 10m ring)
                if (Array.isArray(layers) && layers.length) {
                    ensureLayer();
                    state.live.set(id, { layer: layers, lastTs: ev.ts });
                }
                return; // NOTE: do NOT draw any 168m halo for destroy
            }

            if (ev.type === 'link_destroyed') {
                // 你可以保留/弱化双端提示；或者直接 return 禁用
                // const halos = buildDualHalosForLink(ev); halos.forEach(h=>h.addTo(state.layer));
                return;
            }

            // default: draw 40m uncertainty halo for capture/deploy/link, as before
            const c = buildUncertaintyHalo(ev);
            if (c) {
                ensureLayer();
                c.addTo(state.layer);
                state.live.set(id, { layer: [c] });
            }
        }

        function fadeAndRemove(id, rec) {
            if (!rec || rec.removing) return;
            rec.removing = true;
            const steps = Math.max(1, RENDER.config.haloFadeSteps || 6);
            const interval = Math.round((RENDER.config.haloFadeDuration || 1200) / steps);
            let i = 0;
            const arr = Array.isArray(rec.layer) ? rec.layer : [rec.layer];
            const baseOp = (RENDER.config.haloOpacity ?? 0.35);
            const baseFill = (RENDER.config.haloFillOpacity ?? 0.12);
            const timer = setInterval(() => {
                i++;
                const f = 1 - i / steps;
                for (const l of arr) l.setStyle({ opacity: baseOp * f, fillOpacity: baseFill * f });
                if (i >= steps) {
                    clearInterval(timer);
                    for (const l of arr) l.remove();
                    state.live.delete(id);
                }
            }, interval);
        }

        function refreshWindow() {
            if (state.now == null) return;
            const past = RENDER.config.haloWindowPastMs || 0;
            const future = RENDER.config.haloWindowFutureMs || 0;
            const start = state.now - past;
            const end = state.now + future;

            // 进入窗口：添加
            for (const ev of state.events) {
                if (ev.ts < start) continue;
                if (ev.ts > end) break;
                addEv(ev);
            }

            // 离开窗口：淡出并移除
            for (const [id, rec] of Array.from(state.live.entries())) {
                // 通过 id 反查事件；规模较小时可接受，后续可加并行 map
                const ev = state.events.find(e => eventId(e) === id);
                if (!ev || ev.ts < start || ev.ts > end) fadeAndRemove(id, rec);
            }

            // ----- Link lifecycle rendering -----
            const tNow = state.now;
            if (tNow != null) {
                // 显示：在 [bornTs, deadTs) 内的链
                for (const [key, rec] of state.links.entries()) {
                    if (rec.bornTs == null || rec.deadTs == null) continue;
                    const alive = (tNow >= rec.bornTs && tNow < rec.deadTs);
                    if (alive) {
                        if (!rec.poly) {
                            ensureLayer();
                            const color = _resolveTeamColorByFaction(rec.faction || 'NEUTRAL');
                            rec.poly = L.polyline(
                                [[rec.a.lat, rec.a.lng], [rec.b.lat, rec.b.lng]],
                                { color, weight: RENDER.config.linkStroke || 3, opacity: RENDER.config.linkOpacity ?? 0.85 }
                            ).addTo(state.layer);
                        } else {
                            // keep visible (in case styles changed)
                            try { rec.poly.setStyle({ opacity: RENDER.config.linkOpacity ?? 0.85 }); } catch {}
                        }
                    } else {
                        // 不在存活区间（tNow < bornTs OR tNow >= deadTs）：统一淡出并移除
                        if (rec.poly && !rec.removing) {
                            rec.removing = true;
                            const steps = Math.max(1, RENDER.config.linkFadeSteps || 5);
                            const dt = Math.round((RENDER.config.linkFadeDuration || 800) / steps);
                            let i = 0;
                            const base = RENDER.config.linkOpacity ?? 0.85;
                            const timer = setInterval(() => {
                                i++;
                                const f = 1 - i / steps;
                                try { rec.poly.setStyle({ opacity: base * f }); } catch {}
                                if (i >= steps) {
                                    clearInterval(timer);
                                    try { rec.poly.remove(); } catch {}
                                    rec.poly = null;
                                    rec.removing = false;
                                }
                            }, dt);
                        }
                    }
                }
            }
        }

        function ensureSubscribed() {
            if (state.unsub) return;
            state.unsub = RENDER.clock.on((tPrev, tNow) => {
                state.now = tNow;
                refreshWindow();
            });
        }

        return {
            setEvents(arr) {
                state.events = Array.isArray(arr) ? arr.slice().sort((a, b) => a.ts - b.ts) : [];

                // Build link lifecycle index
                state.links.clear();
                const startBound = RENDER.clock.startTs || (state.events[0]?.ts ?? 0);
                const endBound   = RENDER.clock.endTs   || (state.events[state.events.length-1]?.ts ?? startBound);

                const linkSource = RENDER.config.linksFromAll ? (STORE.events || []) : state.events;

                for (const ev of linkSource) {
                    if (ev.type !== 'link' && ev.type !== 'link_destroyed') continue;
                    if (!Array.isArray(ev.portals) || ev.portals.length < 2) continue;
                    const a = ev.portals[0], b = ev.portals[1];
                    const key = _linkKey(a, b);
                    let rec = state.links.get(key);
                    if (!rec) {
                        rec = { a, b, faction: ev.faction || null, bornTs: null, deadTs: null, poly: null, removing:false };
                        state.links.set(key, rec);
                    }
                    // faction: prefer first non-null (creation时最准确；摧毁行里也可带)
                    if (!rec.faction && ev.faction) rec.faction = ev.faction;

                    if (ev.type === 'link') {
                        // earliest birth
                        rec.bornTs = (rec.bornTs == null) ? ev.ts : Math.min(rec.bornTs, ev.ts);
                    } else if (ev.type === 'link_destroyed') {
                        // earliest valid death after born; 如果还未有born, 先暂存为death
                        rec.deadTs = (rec.deadTs == null) ? ev.ts : Math.min(rec.deadTs, ev.ts);
                    }
                }

                // Fill missing ends by extending to clock bounds (评论1)
                for (const rec of state.links.values()) {
                    if (rec.bornTs == null && rec.deadTs != null) {
                        rec.bornTs = startBound; // 只有摧毁时间：向过去延展
                    } else if (rec.bornTs != null && rec.deadTs == null) {
                        rec.deadTs = endBound;   // 只有创建时间：向未来延展
                    }
                }

                // rebuild per-player indices for attack direction inference
                state.perPlayer.clear();
                for (const ev of state.events) {
                    const who = ev.player || '__UNK__';
                    let bucket = state.perPlayer.get(who);
                    if (!bucket) { bucket = { forty: [], destroy: [] }; state.perPlayer.set(who, bucket); }
                    if (ev.type === 'destroy_reso') bucket.destroy.push(ev);
                    else if (ev.type === 'capture' || ev.type === 'deploy' || ev.type === 'link') bucket.forty.push(ev);
                }
                // keep arrays sorted by ts (state.events 已整体升序；此处稳妥起见再排一次)
                for (const b of state.perPlayer.values()) {
                    b.forty.sort((a,b)=>a.ts-b.ts);
                    b.destroy.sort((a,b)=>a.ts-b.ts);
                }
                ensureSubscribed();
                // 不立即清 live：由 setNow/clock tick 来 reconcile
            },
            setNow(t) {
                state.now = Number(t);
                if (Number.isFinite(state.now)) refreshWindow();
            },
            clear() {
                if (state.layer) state.layer.clearLayers();
                state.live.clear();
                state.events = [];
                state.now = null;
                // 不退订时钟，让控制器常驻；若要彻底销毁，可在此调用 state.unsub()
            },
            getStats() {
                // NOTE: use closure 'state', not 'this'
                const totalEvents = Array.isArray(state.events) ? state.events.length : 0;
                const liveHalos = (state.live && typeof state.live.size === 'number') ? state.live.size : 0;

                // current window bounds (based on state.now)
                const now = (typeof state.now === 'number') ? state.now : null;
                const past = (RENDER.config?.haloWindowPastMs ?? 0);
                const future = (RENDER.config?.haloWindowFutureMs ?? 0);
                const windowStart = (now != null) ? (now - past) : null;
                const windowEnd = (now != null) ? (now + future) : null;

                // current event index (1-based): number of events with ts <= now
                let currentIndex = 0;
                if (now != null && totalEvents > 0) {
                    // binary search upperBound on state.events (sorted by ts asc)
                    let lo = 0, hi = state.events.length;
                    while (lo < hi) {
                        const mid = (lo + hi) >> 1;
                        if (state.events[mid].ts <= now) lo = mid + 1; else hi = mid;
                    }
                    currentIndex = lo; // count of events <= now
                }

                return { totalEvents, liveHalos, windowStart, windowEnd, currentIndex };
            },
        };
    })();


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

        let segCount = 0;
        if (RENDER.config.showSegmentsInOverview) {
            // 延后到 halos 与 now 就绪后，再统一调用 windowed 渲染
        } else {
            const segs = RENDER.buildSegmentsForPlayer(playerName);
            segCount = RENDER.renderSegments(segs);
        }

        // Add halos for this player's events
        const events = (STORE.events || []).filter(ev => ev.player === playerName);
        RENDER.halos.clear();
        RENDER.halos.setEvents(events);
        // 同步时钟范围
        if (events.length) {
            RENDER.clock.setRange(events[0].ts, events[events.length - 1].ts);
        }

        let nowForWindow = RENDER.clock.now;
        if (typeof nowForWindow !== 'number' ||
            nowForWindow < (events[0]?.ts ?? -Infinity) ||
            nowForWindow > (events[events.length - 1]?.ts ?? Infinity)) {
            nowForWindow = events[0]?.ts ?? null;
        }
        if (nowForWindow != null) RENDER.halos.setNow(nowForWindow);

        if (RENDER.config.showSegmentsInOverview) {
            RENDER.renderSegmentsWindowedForPlayers([playerName]);
        }

        if (RENDER.config.showSegmentsInOverview) {
            RENDER.renderSegmentsWindowedForPlayers([playerName]); // 首帧
            RENDER.segmentsWindow.setPlayers([playerName]);        // 驱动后续刷新
        } else {
            RENDER.segmentsWindow.clear();
        }

        console.log(`[trajectory-loader] follow(${playerName}): segments=${segCount}`);
        return segCount;
    };

    // Public API: show track for multiple players (build  render)
    RENDER.showForPlayers = function(playerNames, options = {}) {
        if (!Array.isArray(playerNames) || playerNames.length === 0) {
            console.warn('[trajectory-loader] showForPlayers: empty player list');
            return 0;
        }
        // apply optional overrides (same options as single-player)
        if (options.maxSpeedKmh != null) RENDER.config.maxSpeedKmh = options.maxSpeedKmh;
        if (options.color) RENDER.config.strokeColor = options.color;
        if (options.weight) RENDER.config.strokeWeight = options.weight;

        // init/clear layer
        if (!RENDER.state.layer) {
            RENDER.state.layer = new L.LayerGroup().addTo(window.map);
        } else {
            RENDER.state.layer.clearLayers();
        }
        // Optionally draw segments in overview (default off)
        let segCount = 0;
        if (RENDER.config.showSegmentsInOverview) {
            segCount = RENDER.renderSegmentsWindowedForPlayers(playerNames);
            RENDER.segmentsWindow.setPlayers(playerNames);
        } else {
            RENDER.state.segments = []; // keep empty for player-indexed UI
            RENDER.segmentsWindow.clear();
        }
        // 选中玩家的事件（按人过滤）
        const events = (STORE.events || []).filter(ev => playerNames.includes(ev.player));
        // 将事件交给 HaloController，并把当前窗口时间设到合适位置
        RENDER.halos.clear();
        RENDER.halos.setEvents(events);
        // 同步时钟范围
        if (events.length) {
            RENDER.clock.setRange(events[0].ts, events[events.length - 1].ts);
        }

        // 选择窗口当前时刻：优先 clock.now（若有效），否则首事件时间
        let nowForWindow = RENDER.clock.now;
        if (typeof nowForWindow !== 'number' ||
            nowForWindow < (events[0]?.ts ?? -Infinity) ||
            nowForWindow > (events[events.length - 1]?.ts ?? Infinity)) {
            nowForWindow = events[0]?.ts ?? null;
        }
        if (nowForWindow != null) RENDER.halos.setNow(nowForWindow);

        console.log(`[trajectory-loader] overview: segments=${segCount}`);
        return segCount;
    };


    // Public API: clear current layer
    RENDER.clear = function() {
        if (RENDER.state.layer) RENDER.state.layer.clearLayers();
        RENDER.state.segments = [];
        if (RENDER.halos && RENDER.halos.clear) RENDER.halos.clear();
        RENDER.config.colorByPlayer = {};
        RENDER.clock.pause();
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
                const c = resolveSegmentColor(s);
                if (s.polyline) s.polyline.setStyle({
                    color: c,
                    weight: RENDER.config.strokeWeight,
                    opacity: RENDER.config.strokeOpacity,
                    dashArray: '6,6'
                });
                if (s.arrow1) s.arrow1.setStyle({
                    color: c,
                    weight: RENDER.config.arrowWeight,
                    opacity: RENDER.config.arrowOpacity
                });
                if (s.arrow2) s.arrow2.setStyle({
                    color: c,
                    weight: RENDER.config.arrowWeight,
                    opacity: RENDER.config.arrowOpacity
                });
            }

            const curr = segs[index];
            if (!curr) return;
            // highlight current (purple solid line, thicker, full opacity)
            const hc = resolveSegmentColor(curr);
            curr.polyline.setStyle({
                color: hc,
                weight: RENDER.config.strokeWeight,
                opacity: 1.0,
                dashArray: null                      // solid line
            });
            curr.arrow1.setStyle({ color: hc, weight: RENDER.config.arrowWeight + 1, opacity: 1.0 });
            curr.arrow2.setStyle({ color: hc, weight: RENDER.config.arrowWeight + 1, opacity: 1.0 });

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

        _advance() {
            const segs = RENDER.state.segments || [];
            if (!segs.length) return;
            const i = Math.min((this.idx ?? -1) + 1, segs.length - 1);
            this.highlight(i);
            const ts = segs[i]?.toEv?.ts;
            if (ts) RENDER.clock.seek(ts);
        },

        play() {
            // 1) 对齐时间轴范围（不主动改 now）
            const evs = STORE.timeline?.events || [];
            if (!evs.length) return;
            RENDER.clock.setRange(evs[0].ts, evs[evs.length - 1].ts);

            const segs = RENDER.state.segments || [];

            // Helper：根据 now 选中段索引（优先“包含 now”的段，否则选“to<=now 的最后一段”，都没有则返回 0）
            function pickIndexByNow(nowTs) {
                if (!segs.length || typeof nowTs !== 'number') return -1;

                // ① containment：查找包含 now 的段
                for (let i = 0; i < segs.length; i++) {
                    const s = segs[i];
                    const a = s?.fromEv?.ts ?? -Infinity;
                    const b = s?.toEv?.ts ?? Infinity;
                    if (nowTs >= a && nowTs <= b) return i;
                }

                // ② before：二分“to<=now 的最后一段”
                let lo = 0, hi = segs.length - 1, ans = -1;
                while (lo <= hi) {
                    const mid = (lo + hi) >> 1;
                    const end = segs[mid]?.toEv?.ts ?? -Infinity;
                    if (end <= nowTs) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
                }
                if (ans >= 0) return ans;

                // ③ 全部在 now 之后：返回首段（即将到来的第一段）
                return 0;
            }

            // 2) 计算起播索引 & 时间
            const startBound = STORE.stats.timeStart;
            const endBound   = STORE.stats.timeEnd;
            let now = RENDER.clock.now;

            // 若 now 非法/越界，才对齐到起点
            if (typeof now !== 'number' || now < startBound || now > endBound) {
                now = startBound;
                RENDER.clock.seek(now);
            }

            if (segs.length > 0) {
                // 根据 now 选择 idx，并高亮；不再强行对齐段边界
                const idx = pickIndexByNow(now);
                if (idx >= 0) this.highlight(idx);
                // 直接以当前 now 开始计时（bridge 会在 tick 中把 idx 保持同步）
                RENDER.clock.start();
                this.playing = true;
                return;
            }

            // 无 segments：保持当前 now，不强制回到开始（只在非法/越界时已对齐）
            RENDER.clock.start();
            this.playing = true;
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
                this._advance();           // advances idx and highlights
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
            RENDER.clock.pause()
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

        bindUI(slider, label) {
            this.ui = { slider, label };
            // initialize slider range by timeline
            const evs = STORE.timeline?.events || [];
            if (slider && evs.length) {
                slider.min = String(evs[0].ts);
                slider.max = String(evs[evs.length - 1].ts);
                slider.step = '1000'; // 1s resolution; adjust as you like
                slider.value = String(RENDER.clock.now || evs[0].ts);
                slider.oninput = () => {
                    const ts = Number(slider.value);
                    RENDER.clock.seek(ts);
                    // update immediately for snappy UX
                    this.updateUI?.();
                };
            }

            this.updateUI?.(); // initial sync
        },

        // Update slider min/max/value and label text from current segments & idx
        updateUI() {
            const label = this.ui?.label;
            const slider = this.ui?.slider;

            const now = RENDER.clock.now;
            if (slider && typeof now === 'number') {
                slider.value = String(now); // keep slider synced to virtual time (ms)
            }

            // Fallback time text
            const timeText = (typeof now === 'number') ? formatDateTime(now) : '—';

            // Pull event stats from halo controller
            let totalEv = 0, currentEv = 0;
            try {
                if (RENDER.halos && typeof RENDER.halos.getStats === 'function') {
                    const st = RENDER.halos.getStats();
                    totalEv = st?.totalEvents || 0;
                    currentEv = st?.currentIndex || 0; // 1-based position
                }
            } catch (_) { /* ignore */ }

            if (!label) return;
            // Only show "eventPos / totalEvents [time]"
            label.textContent = `${currentEv} / ${totalEv} [${timeText}]`;
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

        setSpeed(x) {
            const v = RENDER.clock.setSpeed(x);
            console.log('[trajectory-loader] speed x' + v);
        }

    };

    // Bridge: advance segment index by virtual time
    RENDER.player._clockUnsub = RENDER.player._clockUnsub || RENDER.clock.on((tPrev, tNow) => {
        const segs = RENDER.state.segments || [];
        if (!segs.length) { if (RENDER.player.ui) RENDER.player.updateUI?.(); return; }
        // find current segment by time: prefer the one whose [from.ts, to.ts] contains tNow,
        // otherwise pick the last whose end time <= tNow
        let idx = RENDER.player.idx ?? -1;
        // fast path: move forward while next segment ended before/at tNow
        while (idx + 1 < segs.length) {
            const nextEnd = segs[idx + 1]?.toEv?.ts ?? Infinity;
            if (nextEnd <= tNow) idx++; else break;
        }
        // containment check (optional, keeps index correct within a long segment)
        if (idx >= 0) {
            const s = segs[idx];
            const sStart = s?.fromEv?.ts ?? -Infinity;
            const sEnd = s?.toEv?.ts ?? Infinity;
            if (tNow < sStart) idx = Math.max(0, idx - 1); // stepped back due to seek
        }
        if (idx !== RENDER.player.idx) {
            RENDER.player.highlight(idx);
        } else {
            // even if index unchanged, keep UI time label/slider in sync
            RENDER.player.updateUI?.();
        }
    });


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
            const c = resolveSegmentColor(s);
            if (s.polyline) s.polyline.setStyle({ color: c });
            if (s.arrow1) s.arrow1.setStyle({ color: c });
            if (s.arrow2) s.arrow2.setStyle({ color: c });
        }

        // Re-apply highlight styling for the current segment, if any
        if (RENDER.player && RENDER.player.idx >= 0) {
            RENDER.player.highlight(RENDER.player.idx);
        }
        console.log('[trajectory-loader] track color set to', hex);
    };

    // Set or clear a specific player's color override.
    // Usage: setPlayerColor('Alice', '#ff8800');  // set
    //        setPlayerColor('Alice', null);       // clear override
    RENDER.setPlayerColor = function (playerName, hex) {
        if (!playerName || typeof playerName !== 'string') {
            console.warn('[trajectory-loader] setPlayerColor: invalid playerName:', playerName);
            return;
        }
        const map = (RENDER.config.colorByPlayer = RENDER.config.colorByPlayer || {});
        if (hex == null) {
            delete map[playerName];
        } else {
            if (typeof hex !== 'string' || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
                console.warn('[trajectory-loader] setPlayerColor: invalid color:', hex);
                return;
            }
            map[playerName] = hex;
        }

        // Restyle existing segments/arrows in place
        const segs = RENDER.state.segments || [];
        for (const s of segs) {
            if (s.player !== playerName) continue;
            const c = resolveSegmentColor(s);
            if (s.polyline) s.polyline.setStyle({ color: c });
            if (s.arrow1)  s.arrow1.setStyle({  color: c });
            if (s.arrow2)  s.arrow2.setStyle({  color: c });
        }

        // Keep highlight visuals coherent
        if (RENDER.player && RENDER.player.idx >= 0) {
            RENDER.player.highlight(RENDER.player.idx);
        }
        console.log('[trajectory-loader] player color updated:', playerName, hex);
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
        // Section 2: Players & Colors (multi-select + per-player color)
        // ─────────────────────────────────────────────────────────────
        const playersSection = document.createElement('div');
        playersSection.style.marginTop = '12px';

        const playersLabel = document.createElement('div');
        playersLabel.textContent = 'Players (select to replay) & Colors:';
        playersLabel.style.margin = '8px 0 4px 0';
        playersLabel.style.fontWeight = 'bold';
        playersSection.appendChild(playersLabel);

        // Scrollable list container
        const playersList = document.createElement('div');
        playersList.style.maxHeight = '200px';
        playersList.style.overflow = 'auto';
        playersList.style.border = '1px solid rgba(0,0,0,0.2)';
        playersList.style.padding = '6px';
        playersSection.appendChild(playersList);

        // Utility: build the list from STORE.playerIndex
        function rebuildPlayersList() {
            playersList.innerHTML = '';
            const names = STORE.playerIndex ? Object.keys(STORE.playerIndex) : [];
            // sort by activity (desc) if stats are present
            names.sort((a, b) => {
                const ia = STORE.playerIndex?.[a]?.count || 0;
                const ib = STORE.playerIndex?.[b]?.count || 0;
                return ib - ia;
            });
            for (const name of names) {
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.gap = '8px';
                row.style.margin = '4px 0';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = name;
                cb.style.transform = 'scale(1.1)';

                const label = document.createElement('span');
                label.textContent = name;
                label.style.minWidth = '160px';

                const color = document.createElement('input');
                color.type = 'color';
                color.value = (RENDER.config.colorByPlayer?.[name] || '#000000');
                color.oninput = () => {
                    plugin?.trajectoryLoader?.render?.setPlayerColor?.(name, color.value);
                };

                row.appendChild(cb);
                row.appendChild(label);
                row.appendChild(color);
                playersList.appendChild(row);
            }
        }
        rebuildPlayersList();

        // follow 单人 / 概览段线开关
        const chkFollow = document.createElement('input');
        chkFollow.type = 'checkbox';
        chkFollow.style.marginLeft = '8px';
        const lblFollow = document.createElement('label');
        lblFollow.textContent = ' Show full trail when only one player is selected';
        lblFollow.style.marginLeft = '4px';
        const chkSegs = document.createElement('input');
        chkSegs.type = 'checkbox';
        chkSegs.style.marginLeft = '8px';
        const lblSegs = document.createElement('label');
        lblSegs.textContent = ' Show short trails for all players';
        lblSegs.style.marginLeft = '4px';

        const singleCheck = document.createElement('div');
        singleCheck.style.marginTop = '8px';
        singleCheck.style.display = 'flex';
        singleCheck.style.gap = '8px';
        singleCheck.appendChild(chkFollow);
        singleCheck.appendChild(lblFollow);
        playersSection.appendChild(singleCheck);

        const multiCheck = document.createElement('div');
        multiCheck.style.marginTop = '8px';
        multiCheck.style.display = 'flex';
        multiCheck.style.gap = '8px';
        multiCheck.appendChild(chkSegs);
        multiCheck.appendChild(lblSegs);
        playersSection.appendChild(multiCheck);

        // ─────────────────────────────────────────────────────────────
        // Section 3: Summary (numbers) + Progress log (pre)
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
                rebuildPlayersList(); // keep player list in sync
                window.plugin.trajectoryLoader.render.player.bindUI(seekSlider, seekLabel);
            } catch (e) {
                pre.textContent += `\n❌ Error: ${e.message}\n`;
            }
        };

        // ─────────────────────────────────────────────────────────────
        // Section 4: Playback controls ( Play / Pause )
        // ─────────────────────────────────────────────────────────────
        const playbackRow = document.createElement('div');
        playbackRow.style.marginTop = '8px';

        const btnPlay = document.createElement('button');
        btnPlay.textContent = '>> Play';
        btnPlay.style.marginLeft = '6px';
        btnPlay.style.height = '28px';
        btnPlay.onclick = () => window.plugin.trajectoryLoader.render.player.play();

        const btnPause = document.createElement('button');
        btnPause.textContent = '-- Pause';
        btnPause.style.marginLeft = '6px';
        btnPause.style.height = '28px';
        btnPause.onclick = () => window.plugin.trajectoryLoader.render.player.pause();

        // Action buttons: render & clear

        const btnRender = document.createElement('button');
        btnRender.textContent = 'Render';
        btnRender.style.marginLeft = '6px';
        btnRender.style.height = '28px';
        btnRender.onclick = () => {
            // gather checked players
            const boxes = playersList.querySelectorAll('input[type="checkbox"]');
            const selected = Array.from(boxes).filter(b => b.checked).map(b => b.value);
            if (selected.length === 0) {
                console.warn('[trajectory-loader] no players selected');
                return;
            }
            RENDER.config.showSegmentsInOverview = !!chkSegs.checked;
            if (chkFollow.checked && selected.length === 1) {
                plugin?.trajectoryLoader?.render?.showForPlayer?.(selected[0], {});
            } else {
                plugin?.trajectoryLoader?.render?.showForPlayers?.(selected, {});
            }
            // enable player UI slider/label if present
            if (RENDER && RENDER.player && RENDER.player.updateUI) RENDER.player.updateUI();
        };

        const btnClear = document.createElement('button');
        btnClear.textContent = 'Clear';
        btnClear.style.marginLeft = '6px';
        btnClear.style.height = '28px';
        btnClear.onclick = () => {
            plugin.trajectoryLoader.render.clear();
            if (RENDER && RENDER.player) RENDER.player.stop?.();
        };

        playbackRow.appendChild(btnClear);
        playbackRow.appendChild(btnRender);
        playbackRow.appendChild(btnPlay);
        playbackRow.appendChild(btnPause);

        // ─────────────────────────────────────────────────────────────
        // Section 4.5: Speed presets (1× / 10× / 25× / 50× / 100×)
        // ─────────────────────────────────────────────────────────────
        const speedRow = document.createElement('div');
        speedRow.style.marginTop = '6px';

        const speedLabel = document.createElement('span');
        speedLabel.textContent = 'Speed:';
        speedLabel.style.display = 'inline-block';
        speedLabel.style.marginRight = '6px';
        speedRow.appendChild(speedLabel);

        const presetVals = (RENDER.config.speedPresets || [1,10,25,50,100]).slice();
        const btns = [];

        function _applySpeed(v) {
            const ok = window.plugin.trajectoryLoader.render.clock.setSpeed(v);
            // 高亮当前选择
            for (const b of btns) {
                const active = (Number(b.dataset.v) === ok);
                b.style.fontWeight = active ? 'bold' : 'normal';
                b.style.opacity = active ? '1.0' : '0.7';
            }
            try { localStorage.setItem('trajectoryLoader.speed', String(ok)); } catch {}
        }

        for (let i = 0; i < presetVals.length; i++) {
            const v = presetVals[i];
            const b = document.createElement('button');
            b.textContent = `${v}×`;
            b.dataset.v = String(v);
            b.style.height = '24px';
            b.style.marginLeft = i === 0 ? '6px' : '4px';
            b.onclick = () => _applySpeed(v);
            btns.push(b);
            speedRow.appendChild(b);
        }

        // 初始化：从 localStorage 恢复；否则按 defaultSpeedIndex
        let initV = null;
        try {
            const saved = Number(localStorage.getItem('trajectoryLoader.speed'));
            if (isFinite(saved) && saved >= 1) initV = saved;
        } catch {}

        if (!initV) {
            const idx = Math.max(0, Math.min((RENDER.config.defaultSpeedIndex|0), presetVals.length - 1));
            initV = presetVals[idx];
        }
        _applySpeed(initV);

        // ─────────────────────────────────────────────────────────────
        // Section 5: Quick seek (label + range slider)
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

        window.plugin.trajectoryLoader.render.player.bindUI(seekSlider, seekLabel);

        seekRow.appendChild(seekLabel);
        seekRow.appendChild(seekSlider);

        // ─────────────────────────────────────────────────────────────
        // Compose all sections
        // ─────────────────────────────────────────────────────────────
        container.appendChild(fileSection);
        container.appendChild(summary);
        container.appendChild(pre);
        // Attach Section 2 to the dialog container
        container.appendChild(playersSection);
        container.appendChild(playbackRow);
        container.appendChild(speedRow);
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

