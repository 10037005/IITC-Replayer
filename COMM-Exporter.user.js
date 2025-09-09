// ==UserScript==
// @id             iitc-plugin-comm-exporter
// @name           COMM Exporter
// @category       COMM
// @version        3.5.1
// @description    Export COMM logs in a time + map range using direct fetch to /r/getPlexts
// @match          https://intel.ingress.com/*
// @grant          none
// ==/UserScript==



function wrapper(plugin_info) {
  if (typeof window.plugin !== 'function') window.plugin = () => { };

  plugin_info.dateTimeVersion = '20250702';
  plugin_info.buildName = 'beta';
  plugin_info.pluginId = 'iitc-plugin-comm-exporter';

  const generateBoundsOptions = (lat, lng) => {
    const options = [];
    const earthRadiusLat = 111000;
    const earthRadiusLng = 111000 * Math.cos(lat * Math.PI / 180);
    for (let i = 0; i < 10; i++) {
      const halfSide = 50 * Math.pow(2, i);
      const deltaLat = halfSide / earthRadiusLat;
      const deltaLng = halfSide / earthRadiusLng;
      options.push({
        label: `${halfSide * 2}m range`,
        bounds: {
          minLatE6: Math.round((lat - deltaLat) * 1e6),
          minLngE6: Math.round((lng - deltaLng) * 1e6),
          maxLatE6: Math.round((lat + deltaLat) * 1e6),
          maxLngE6: Math.round((lng + deltaLng) * 1e6)
        }
      });
    }
    return options;
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    const yy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${yy}${mm}${dd}${hh}${mi}${ss}`;
  }

  const plugin = {};

  plugin.ui = {
    container: null,
    inputStart: null,
    inputEnd: null,
    inputMax: null,
    checkbox: null,
    select: null,
    progress: null,
  };

  plugin.ui.open = () => {
    if (plugin.ui.container) return;

    const selectedPortal = window.portals[window.selectedPortal];
    const hasPortal = !!selectedPortal;

    const container = document.createElement('div');

    const label = (text) => {
      const l = document.createElement('label');
      l.textContent = text;
      l.style.display = 'block';
      l.style.marginTop = '6px';
      return l;
    };

    plugin.ui.inputStart = document.createElement('input');
    plugin.ui.inputStart.type = 'datetime-local';

    plugin.ui.inputEnd = document.createElement('input');
    plugin.ui.inputEnd.type = 'datetime-local';

    plugin.ui.inputMax = document.createElement('input');
    plugin.ui.inputMax.type = 'number';
    plugin.ui.inputMax.value = 100;

    plugin.ui.checkbox = document.createElement('input');
    plugin.ui.checkbox.type = 'checkbox';

    plugin.ui.select = document.createElement('select');
    plugin.ui.select.style.height = '28px';
    plugin.ui.select.disabled = true;

    if (hasPortal) {
      const latLng = selectedPortal.getLatLng();
      const options = generateBoundsOptions(latLng.lat, latLng.lng);
      options.forEach(opt => {
        const option = document.createElement('option');
        option.value = JSON.stringify(opt.bounds);
        option.textContent = opt.label;
        plugin.ui.select.appendChild(option);
      });
      plugin.ui.checkbox.disabled = false;
      plugin.ui.checkbox.onchange = () => {
        plugin.ui.select.disabled = !plugin.ui.checkbox.checked;
      };
    } else {
      plugin.ui.checkbox.disabled = true;
    }

    const usePortalLabel = document.createElement('label');
    usePortalLabel.textContent = 'Use selected portal bounds';
    usePortalLabel.style.display = 'flex';
    usePortalLabel.style.alignItems = 'center';
    usePortalLabel.style.marginTop = '15px';
    usePortalLabel.appendChild(plugin.ui.checkbox);

    plugin.ui.progress = document.createElement('pre');
    plugin.ui.progress.style.marginTop = '10px';
    plugin.ui.progress.style.maxHeight = '100px';
    plugin.ui.progress.style.overflowY = 'auto';
    plugin.ui.progress.style.whiteSpace = 'pre-wrap';
    plugin.ui.progress.textContent = '\n';

    container.appendChild(label('Start Time:'));
    container.appendChild(plugin.ui.inputStart);
    container.appendChild(label('End Time:'));
    container.appendChild(plugin.ui.inputEnd);
    container.appendChild(label('Max Pages:'));
    container.appendChild(plugin.ui.inputMax);
    container.appendChild(usePortalLabel);
    container.appendChild(label('Bounds (if using portal):'));
    container.appendChild(plugin.ui.select);
    container.appendChild(plugin.ui.progress);

    window.dialog({
      html: container,
      title: 'COMM Exporter',
      id: 'plugin-comm-exporter',
      dialogClass: 'plugin-comm-exporter-dialog',
      buttons: {
        'Start Export': () => {
          const startTime = new Date(plugin.ui.inputStart.value).getTime();
          const endTime = new Date(plugin.ui.inputEnd.value).getTime();
          const maxPages = parseInt(plugin.ui.inputMax.value);
          const bounds = plugin.ui.checkbox.checked ? JSON.parse(plugin.ui.select.value) : null;
          plugin.run(startTime, endTime, maxPages, bounds);
        },
      },
      closeCallback: () => {
        plugin.ui.container = null;
      }
    });

    plugin.ui.container = true;
  };

  plugin.run = async (startTime, endTime, maxPages = 100, overrideBounds = null) => {
    if (isNaN(startTime) || isNaN(endTime) || endTime <= startTime) {
      plugin.ui.progress.textContent += `❌ Invalid time range: ${new Date(startTime).toLocaleString()} - ${new Date(endTime).toLocaleString()}\n`;
      return console.error("❌ Invalid time range.");
    }

    let bounds = overrideBounds || (() => {
      const b = window.map.getBounds();
      return {
        minLatE6: Math.round(b.getSouth() * 1e6),
        minLngE6: Math.round(b.getWest() * 1e6),
        maxLatE6: Math.round(b.getNorth() * 1e6),
        maxLngE6: Math.round(b.getEast() * 1e6)
      };
    })();

    plugin.ui.progress.textContent += `🚀 Starting export...\n`;

    let collected = [];
    let page = 0;
    let continuationGuid = null;
    let cursorTime = endTime;

    const getCookie = (name) => {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) return parts.pop().split(';').shift();
    };

    while (true) {
      const body = {
        ...bounds,
        minTimestampMs: -1,
        maxTimestampMs: cursorTime,
        tab: 'all',
        v: window.niantic_params.CURRENT_VERSION,
        continuationGuid: continuationGuid || null,
      };

      const res = await fetch('/r/getPlexts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrftoken': getCookie('csrftoken') || '',
          'x-requested-with': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        console.error("❌ Network error on page", page);
        break;
      }

      const json = await res.json();
      const result = json.result || [];
      if (result.length === 0) break;

      collected.push(...result);
      console.log(result[result.length - 1][1], cursorTime);
      if (result[result.length - 1][1] === cursorTime) {
        cursorTime = result[result.length - 1][1] - 1;
      } else {
        cursorTime = result[result.length - 1][1];
      }
      if (startTime > cursorTime) {
        plugin.ui.progress.textContent += `✅ All logs during the period has been logged\n`;
        break;
      }

      continuationGuid = result[result.length - 1][0];
      page++;
      if (page >= maxPages) {
        plugin.ui.progress.textContent += `✅ Reached max pages limit (${maxPages})\n`;
        break;
      }

      const text = `📦 Page ${page}: ${new Date(cursorTime).toLocaleString()} ${cursorTime}`;
      plugin.ui.progress.textContent += text + "\n";
    }

    const parsed = collected
      .map(r => window.IITC.comm.parseMsgData(r))
      .filter(m => m.type !== 'SYSTEM_NARROWCAST' && m.alert == false)
      .map(m => {
        if (m.markup) {
          m.markup.forEach(entry => {
            console.log(entry);
            if (entry[0] === 'PORTAL') {
              const guid = findPortalGuidByPositionE6(entry[1].latE6, entry[1].lngE6);
              if (guid) entry[1].guid = guid;
            }
          });
        }
        return m;
      });

    const output = {
      range: [startTime, endTime],
      bounds,
      count: parsed.length,
      messages: parsed
    };

    const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `comm_logs_${formatTime(startTime)}_${formatTime(endTime)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    plugin.ui.progress.textContent += `\n✅ Export complete: ${parsed.length} messages\n`;
    console.log("✅ Export complete:", parsed.length, "messages");
    window._chatLogResult = output;
  };

  const setup = () => {
    IITC.toolbox.addButton({
      label: 'COMM Export',
      title: 'Export public COMM logs',
      action: plugin.ui.open
    });
  };

  setup.info = plugin_info;
  if (!window.bootPlugins) window.bootPlugins = [];
  window.bootPlugins.push(setup);
  if (window.iitcLoaded && typeof setup === 'function') setup();
}

const info = {}
const script = document.createElement('script');
const textContent = '(' + wrapper.toString() + ')(' + JSON.stringify(info) + ');';
script.appendChild(document.createTextNode(textContent));
(document.body || document.head || document.documentElement).appendChild(script);
