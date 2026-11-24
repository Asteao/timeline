    // Relative so a branch preview loads its own copy of the timeline
    // instead of the one on the live site.
    const TIMELINE_URL = 'timelines/jensen-huang-controversy.json';

    let timeline = null;

    async function fetchTimeline(url) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch timeline: ${response.status}`);
      }

      const data = await response.json();

      if (data.schema_version !== 1 || !Array.isArray(data.events)) {
        throw new Error('Not a timeline file (expected schema_version 1 and an events array).');
      }

      return data;
    }

    const track = document.querySelector('.timeline-track');
    const minimapTrack = document.querySelector('.minimap-track');
    const minimapViewport = document.querySelector('.minimap-viewport');

    // Zoom runs on a 0-127 scale, step 0 showing the whole timeline
    // (1x) and step 127 the maximum. The scale is geometric: each
    // unit multiplies the zoom by the same ratio, so the slider feels
    // even across the whole range. Positions on the scale are
    // continuous, not just whole steps, so a click can land on the
    // exact zoom that fits an event, and the slider moves smoothly;
    // the quick methods still jump 16 units at a time. The maximum
    // is set from the data when the timeline loads (see
    // computeMaxZoom); until then it is the old 128x, which is also
    // the floor, so a sparse timeline never loses range it used to
    // have.
    const ZOOM_STEPS = 128;
    const ZOOM_JUMP = 16;
    // How much of the viewport a click-to-zoom fit fills: 90% in
    // landscape, so the fitted range lands fully in view with a 5%
    // margin at each side instead of exactly on the viewport edge.
    // Portrait fills 85%: the phone viewport is much shorter in px
    // while a label is the same absolute size, so 5% there leaves
    // a tall label almost touching the edge (on a phone with the
    // address bar shown, the tallest label is clipped outright).
    const FIT_FRACTION = 0.9;
    const FIT_FRACTION_PORTRAIT = 0.85;
    let maxZoom = 128;
    let zoomStep = 0;
    let zoom = 1;

    function zoomForStep(step) {
      return Math.pow(maxZoom, step / (ZOOM_STEPS - 1));
    }

    function formatZoom(value) {
      return `${value >= 100 ? Math.round(value) : value.toFixed(1)}x`;
    }

    // Events and the fraction along the track their label anchors to:
    // a dot's position, or a bar's midpoint. Declared here, before
    // syncZoomUI runs at load, because syncZoomUI now re-lays out
    // the labels; declaring it next to drawEvents meant the load-time
    // call hit the variable before it existed and the whole script
    // died before the timeline loaded.
    let labelTargets = [];

    // Time-scale ticks: short dashes across the timeline marking the
    // boundaries of time units, sized by unit so the scale reads at a
    // glance — seconds are the shortest, then minutes, hours, days,
    // and on up to millennia: 6px for seconds, growing 2px per level
    // to 22px for millennia. The units are the data structure's own
    // precision list (see data-structure.md). Which units appear
    // depends on the zoom: a unit is shown only when its ticks are at
    // least MIN_TICK_SPACING px apart, so zooming in reveals finer
    // units and zooming out hides them before they merge into a solid
    // line. Ticks are drawn only for the visible range, re-placed on
    // zoom, scroll and resize — drawing them for the whole timeline
    // at second precision would be tens of thousands of elements.
    // The `ms` for month and above is a nominal duration, used only
    // for the spacing check; the boundaries themselves follow the
    // calendar (1st of the month, Jan 1), see tickBoundaries.
    const TICK_UNITS = [
      { name: 'second', ms: 1000, size: 6 },
      { name: 'minute', ms: 60 * 1000, size: 8 },
      { name: 'hour', ms: 3600 * 1000, size: 10 },
      { name: 'day', ms: 86400 * 1000, size: 12 },
      { name: 'month', ms: 30.44 * 86400 * 1000, size: 14 },
      { name: 'year', ms: 365.25 * 86400 * 1000, size: 16 },
      { name: 'decade', ms: 10 * 365.25 * 86400 * 1000, size: 18 },
      { name: 'century', ms: 100 * 365.25 * 86400 * 1000, size: 20 },
      { name: 'millennium', ms: 1000 * 365.25 * 86400 * 1000, size: 22 },
    ];
    const MIN_TICK_SPACING = 8;

    // The timeline's time range in ms, set when the events are drawn.
    let timelineStartMs = 0;
    let timelineEndMs = 0;

    // The container holding the tick elements, created once the
    // events are drawn (after the dots and bars, so it paints above
    // them). updateTicks fills it.
    let ticksContainer = null;

    // The lanes the on-screen labels ended up in, as intervals
    // along the track in px. layoutLabels fills this in; the
    // off-screen labels copy it so they do not overlap an
    // on-screen label in the lane they take. It holds on-screen
    // labels only: the off-screen placements go in a throwaway
    // copy, or their intervals would pile up here on every scroll
    // and eventually crowd the edge labels out entirely.
    let placedLanes = [[], []];

    // The gap kept between neighbouring labels in a lane.
    const LABEL_GAP = 4;

    const zoomInButton = document.getElementById('zoom-in');
    const zoomOutButton = document.getElementById('zoom-out');
    const zoomTrack = document.getElementById('zoom-track');

    function syncZoomUI() {
      zoomInButton.disabled = zoomStep >= ZOOM_STEPS - 1;
      zoomOutButton.disabled = zoomStep <= 0;
      zoomTrack.style.setProperty('--frac', String(zoomStep / (ZOOM_STEPS - 1)));
      zoomTrack.setAttribute('aria-valuenow', String(Math.round(zoomStep)));
      zoomTrack.setAttribute('aria-valuetext', formatZoom(zoom));
      console.log('Zoom:', formatZoom(zoom));
      layoutLabels();
    }

    // Zoom to a step, keeping the timeline point under `anchor`
    // (client coordinates) in the same place on screen. Without an
    // anchor the viewport centre is used, so buttons, slider and
    // keyboard zoom into the middle. The point's fraction along the
    // track is measured before the zoom and the page is scrolled
    // afterwards so that same fraction sits under the anchor again.
    // window.scrollTo clamps at the ends, so an anchor outside the
    // track (e.g. over the end padding) drifts slightly instead of
    // scrolling past the end.
    function setZoomStep(newStep, anchor = { x: window.innerWidth / 2, y: window.innerHeight / 2 }) {
      const clamped = Math.min(ZOOM_STEPS - 1, Math.max(0, newStep));
      if (clamped === zoomStep) {
        return;
      }

      const rect = track.getBoundingClientRect();
      const fx = rect.width ? (anchor.x - rect.left) / rect.width : 0.5;
      const fy = rect.height ? (anchor.y - rect.top) / rect.height : 0.5;

      zoomStep = clamped;
      zoom = zoomForStep(zoomStep);
      track.style.setProperty('--zoom', zoom);
      syncZoomUI();

      const newRect = track.getBoundingClientRect();
      const newScrollX = rect.left + window.scrollX - anchor.x + fx * newRect.width;
      const newScrollY = rect.top + window.scrollY - anchor.y + fy * newRect.height;
      window.scrollTo(newScrollX, newScrollY);
    }

    // The quick methods move 16 steps at a time, about 3x at the
    // Starship range, so eight presses still cross the whole range.
    function zoomIn(anchor) {
      setZoomStep(zoomStep + ZOOM_JUMP, anchor);
    }

    function zoomOut(anchor) {
      setZoomStep(zoomStep - ZOOM_JUMP, anchor);
    }

    // Snap the zoom and scroll so a time range spans the page: the
    // exact zoom at which the range fills 90% of the viewport in
    // landscape (85% in portrait), with the range centred, so the
    // fitted event lands fully in view with a margin at each side
    // instead of exactly on the viewport edge. The scale is
    // continuous, so this is the precise fit rather than the nearest
    // step. Clicking a duration event's bar or label fits the event
    // itself; clicking an off-screen label fits the union of the
    // visible range and the event, so what is already on screen
    // stays in view.
    function zoomToRange(startFrac, endFrac) {
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      const span = endFrac - startFrac;
      const fitFraction = landscape ? FIT_FRACTION : FIT_FRACTION_PORTRAIT;
      const exactFit = fitFraction / (0.8 * span);
      const step = Math.min(ZOOM_STEPS - 1, Math.max(0, Math.log(exactFit) / Math.log(zoomForStep(1))));
      setZoomStep(step);

      const rect = track.getBoundingClientRect();
      const trackLength = landscape ? rect.width : rect.height;
      const mid = ((startFrac + endFrac) / 2) * trackLength;
      if (landscape) {
        window.scrollTo(rect.left + window.scrollX + mid - window.innerWidth / 2, window.scrollY);
      } else {
        window.scrollTo(window.scrollX, rect.top + window.scrollY + mid - window.innerHeight / 2);
      }
    }

    // The maximum zoom is set from the data: far enough that the two
    // closest event boundaries (starts and ends) sit 100px apart, so
    // the densest cluster can be pulled apart far enough to read.
    // Coincident boundaries (zero gap) can never be separated by
    // zooming, so they are ignored. The old 128x is the floor.
    function computeMaxZoom(events) {
      const times = [];
      for (const event of events) {
        times.push(Date.parse(event.start.at));
        if (event.end) {
          times.push(Date.parse(event.end.at));
        }
      }
      times.sort((a, b) => a - b);
      let minGap = Infinity;
      for (let i = 1; i < times.length; i++) {
        const gap = times[i] - times[i - 1];
        if (gap > 0 && gap < minGap) {
          minGap = gap;
        }
      }
      const range = times[times.length - 1] - times[0];
      if (!Number.isFinite(minGap) || range <= 0) {
        return;
      }
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      const trackLength = landscape ? track.offsetWidth : track.offsetHeight;
      const needed = 100 / ((minGap / range) * trackLength);
      maxZoom = Math.max(128, needed);
      zoom = zoomForStep(zoomStep);
      track.style.setProperty('--zoom', zoom);
      console.log('Max zoom:', formatZoom(maxZoom), `(closest events ${minGap / 1000}s apart)`);
      syncZoomUI();
    }

    // Baseline method: + / - buttons, now inside the slider bar.
    // Their pointerdown must not reach the slider track, or pressing
    // - would jump the zoom to 1x instead of stepping down one level.
    zoomInButton.addEventListener('click', () => zoomIn());
    zoomOutButton.addEventListener('click', () => zoomOut());
    for (const button of [zoomInButton, zoomOutButton]) {
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
    }

    // Custom slider, log scale (1x to max zoom). Click or drag on
    // the bar to set the zoom; arrow keys move a single unit when
    // the bar has focus. In portrait the bar runs vertically, so
    // the fraction is measured from the top: the top is the
    // maximum zoom and the bottom is 1x.
    function sliderStepFromEvent(event) {
      const rect = zoomTrack.getBoundingClientRect();
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      const frac = landscape
        ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
        : Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / rect.height));
      return frac * (ZOOM_STEPS - 1);
    }

    let sliderDragging = false;

    zoomTrack.addEventListener('pointerdown', (event) => {
      sliderDragging = true;
      zoomTrack.setPointerCapture(event.pointerId);
      setZoomStep(sliderStepFromEvent(event));
    });

    zoomTrack.addEventListener('pointermove', (event) => {
      if (sliderDragging) {
        setZoomStep(sliderStepFromEvent(event));
      }
    });

    zoomTrack.addEventListener('pointerup', () => {
      sliderDragging = false;
    });

    // If the browser cancels the drag (e.g. it took the gesture
    // over as a scroll), stop dragging too, or a later pointer
    // move over the bar would move the zoom unexpectedly.
    zoomTrack.addEventListener('pointercancel', () => {
      sliderDragging = false;
    });

    zoomTrack.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        event.preventDefault();
        setZoomStep(zoomStep + 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        event.preventDefault();
        setZoomStep(zoomStep - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setZoomStep(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setZoomStep(ZOOM_STEPS - 1);
      }
    });

    // Scroll up to zoom in, scroll down to zoom out.
    // A mostly-horizontal swipe is panning, so it is left alone.
    // Wheel events arrive in small increments on a trackpad, so they
    // are accumulated until they add up to one jump (16 steps).
    let wheelAccum = 0;
    window.addEventListener('wheel', (event) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        return;
      }
      event.preventDefault();
      wheelAccum += event.deltaY;
      const anchor = { x: event.clientX, y: event.clientY };
      if (wheelAccum <= -100) {
        zoomIn(anchor);
        wheelAccum = 0;
      } else if (wheelAccum >= 100) {
        zoomOut(anchor);
        wheelAccum = 0;
      }
    }, { passive: false });

    // Keyboard: + / - to zoom by a jump, 0 to reset.
    window.addEventListener('keydown', (event) => {
      if (event.key === '+' || event.key === '=') {
        zoomIn();
      } else if (event.key === '-' || event.key === '_') {
        zoomOut();
      } else if (event.key === '0') {
        setZoomStep(0);
      }
    });

    // Double-click the timeline to zoom in by a jump,
    // Shift+double-click to zoom out.
    track.addEventListener('dblclick', (event) => {
      const anchor = { x: event.clientX, y: event.clientY };
      if (event.shiftKey) {
        zoomOut(anchor);
      } else {
        zoomIn(anchor);
      }
    });

    // Pinch to zoom on touch screens. Two fingers on the page zoom
    // the timeline, anchored at the midpoint between them, with the
    // zoom following the ratio of the finger distance to the distance
    // when the second finger landed — so spreading the fingers apart
    // zooms in and bringing them together zooms out, smoothly and
    // continuously, like the slider. A single finger is left alone:
    // the body's touch-action (pan-x in landscape, pan-y in
    // portrait) lets the browser keep single-finger panning, and
    // hands the two-finger gesture to the page as pointer events
    // instead of zooming the page itself. Touches starting on the
    // zoom slider are the slider's own and are ignored here.
    const pinchPointers = new Map();
    let pinchStartDistance = 0;
    let pinchStartZoom = 1;
    let pinchStartFrac = 0;
    let pinchEndTime = 0;

    function pinchDistance() {
      const [a, b] = [...pinchPointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function pinchMidpoint() {
      const [a, b] = [...pinchPointers.values()];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    // The timeline fraction under a client point, clamped to the
    // timeline itself (a finger over the end padding is outside it).
    function fracUnderPoint(x, y) {
      const rect = track.getBoundingClientRect();
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      const frac = landscape ? (x - rect.left) / rect.width : (y - rect.top) / rect.height;
      return Math.min(1, Math.max(0, frac));
    }

    // Zoom to `newZoom` and scroll so the timeline fraction that
    // was under the pinch's starting midpoint stays under the
    // midpoint as it moves. Anchoring on that fixed fraction (rather
    // than re-measuring under the midpoint on every move) means the
    // content under the fingers never drifts, however the two
    // fingers take turns moving.
    function pinchZoomTo(newZoom, midpoint) {
      const step = Math.log(newZoom) / Math.log(zoomForStep(1));
      setZoomStep(step);
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      const rect = track.getBoundingClientRect();
      const trackLength = landscape ? rect.width : rect.height;
      const mid = pinchStartFrac * trackLength;
      if (landscape) {
        window.scrollTo(rect.left + window.scrollX + mid - midpoint.x, window.scrollY);
      } else {
        window.scrollTo(window.scrollX, rect.top + window.scrollY + mid - midpoint.y);
      }
    }

    window.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch') {
        return;
      }
      if (event.target.closest?.('.zoom-slider, .minimap')) {
        return;
      }
      pinchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinchPointers.size === 2) {
        pinchStartDistance = pinchDistance();
        pinchStartZoom = zoom;
        const mid = pinchMidpoint();
        pinchStartFrac = fracUnderPoint(mid.x, mid.y);
      }
    });

    window.addEventListener('pointermove', (event) => {
      if (!pinchPointers.has(event.pointerId)) {
        return;
      }
      pinchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinchPointers.size === 2 && pinchStartDistance > 0) {
        const newZoom = Math.min(maxZoom, Math.max(1, pinchStartZoom * pinchDistance() / pinchStartDistance));
        pinchZoomTo(newZoom, pinchMidpoint());
      }
    });

    function endPinchPointer(event) {
      if (!pinchPointers.has(event.pointerId)) {
        return;
      }
      const wasPinching = pinchPointers.size === 2;
      pinchPointers.delete(event.pointerId);
      if (wasPinching) {
        pinchStartDistance = 0;
        // A pinch ending on a bar or label must not fire that
        // element's click, which would snap-zoom and undo the
        // pinch. Clicks for a short while after a pinch are
        // swallowed below.
        pinchEndTime = Date.now();
      }
    }

    window.addEventListener('pointerup', endPinchPointer);
    window.addEventListener('pointercancel', endPinchPointer);

    window.addEventListener('click', (event) => {
      if (Date.now() - pinchEndTime < 350) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);

    // Minimap navigation: clicking the minimap jumps the main view
    // so the clicked point is centred, keeping the current zoom,
    // and dragging keeps the point under the pointer centred, so
    // the minimap works like a scrubber. At 1x the whole timeline
    // is already in view, so there is nowhere to go and a click
    // does nothing. Pointer capture keeps the drag alive if the
    // pointer leaves the strip mid-drag.
    function minimapFractionFromEvent(event) {
      const rect = minimapTrack.getBoundingClientRect();
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      const frac = landscape ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
      return Math.min(1, Math.max(0, frac));
    }

    function centreViewOnFraction(frac) {
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      const rect = track.getBoundingClientRect();
      const trackLength = landscape ? rect.width : rect.height;
      const point = frac * trackLength;
      if (landscape) {
        window.scrollTo(rect.left + window.scrollX + point - window.innerWidth / 2, window.scrollY);
      } else {
        window.scrollTo(window.scrollX, rect.top + window.scrollY + point - window.innerHeight / 2);
      }
    }

    let minimapDragging = false;
    minimapTrack.addEventListener('pointerdown', (event) => {
      minimapDragging = true;
      minimapTrack.setPointerCapture(event.pointerId);
      minimapTrack.style.cursor = 'grabbing';
      centreViewOnFraction(minimapFractionFromEvent(event));
    });
    minimapTrack.addEventListener('pointermove', (event) => {
      if (!minimapDragging) {
        return;
      }
      centreViewOnFraction(minimapFractionFromEvent(event));
    });
    const endMinimapDrag = () => {
      minimapDragging = false;
      minimapTrack.style.cursor = '';
    };
    minimapTrack.addEventListener('pointerup', endMinimapDrag);
    minimapTrack.addEventListener('pointercancel', endMinimapDrag);

    track.style.setProperty('--zoom', zoom);
    syncZoomUI();

    function drawEvents(events) {
      const starts = events.map((event) => Date.parse(event.start.at));
      const ends = events.map((event) => (event.end ? Date.parse(event.end.at) : null));
      const start = Math.min(...starts);
      const end = Math.max(...starts, ...ends.filter((time) => time !== null));
      timelineStartMs = start;
      timelineEndMs = end;
      const position = (time) => (end === start ? 50 : ((time - start) / (end - start)) * 100);
      labelTargets = [];

      // Bars first, so dots render on top of them. The bars are
      // appended longest first, so a short bar is never hidden
      // underneath a longer one it overlaps: the booster flight bar
      // sits inside the ship flight bar's span, and used to disappear
      // under it, which also made its label look detached from the
      // visible blue. Labels keep file order below, so this does not
      // change which labels win a lane.
      const bars = [];
      events.forEach((event, index) => {
        if (!event.end) {
          return;
        }
        const bar = document.createElement('div');
        bar.className = 'event-bar';
        bar.setAttribute('aria-hidden', 'true');
        bar.style.setProperty('--pos', `${position(starts[index])}%`);
        bar.style.setProperty('--end-pos', `${position(ends[index])}%`);
        if (event.style && event.style.color) {
          bar.style.background = event.style.color;
        }
        bar.addEventListener('click', () => zoomToRange(position(starts[index]) / 100, position(ends[index]) / 100));
        bars.push({ bar, span: ends[index] - starts[index] });
        labelTargets.push({ event, frac: (position(starts[index]) + position(ends[index])) / 2, startFrac: position(starts[index]) / 100, endFrac: position(ends[index]) / 100 });
      });
      bars.sort((a, b) => b.span - a.span).forEach(({ bar }) => track.appendChild(bar));

      events.forEach((event, index) => {
        if (event.end) {
          return;
        }
        const dot = document.createElement('div');
        dot.className = 'event-dot';
        dot.setAttribute('aria-hidden', 'true');
        dot.style.setProperty('--pos', `${position(starts[index])}%`);
        if (event.style && event.style.color) {
          dot.style.background = event.style.color;
        }
        track.appendChild(dot);
        labelTargets.push({ event, frac: position(starts[index]) });
      });
    }

    // Minimap: a second copy of the timeline without labels, fixed
    // to the top of the page (left in portrait). Same dots and bars,
    // with their colours, at the same time positions — only smaller
    // (8px instead of 12px) and with no click handlers: it is
    // display-only. Bars are appended longest first, as in
    // drawEvents, so a short bar is never hidden under a longer one.
    function drawMinimap(events) {
      const starts = events.map((event) => Date.parse(event.start.at));
      const ends = events.map((event) => (event.end ? Date.parse(event.end.at) : null));
      const start = Math.min(...starts);
      const end = Math.max(...starts, ...ends.filter((time) => time !== null));
      const position = (time) => (end === start ? 50 : ((time - start) / (end - start)) * 100);

      const bars = [];
      events.forEach((event, index) => {
        if (!event.end) {
          return;
        }
        const bar = document.createElement('div');
        bar.className = 'minimap-bar';
        bar.setAttribute('aria-hidden', 'true');
        bar.style.setProperty('--pos', `${position(starts[index])}%`);
        bar.style.setProperty('--end-pos', `${position(ends[index])}%`);
        if (event.style && event.style.color) {
          bar.style.background = event.style.color;
        }
        bars.push({ bar, span: ends[index] - starts[index] });
      });
      bars.sort((a, b) => b.span - a.span).forEach(({ bar }) => minimapTrack.appendChild(bar));

      events.forEach((event, index) => {
        if (event.end) {
          return;
        }
        const dot = document.createElement('div');
        dot.className = 'minimap-dot';
        dot.setAttribute('aria-hidden', 'true');
        dot.style.setProperty('--pos', `${position(starts[index])}%`);
        if (event.style && event.style.color) {
          dot.style.background = event.style.color;
        }
        minimapTrack.appendChild(dot);
      });
    }

    // The box on the minimap highlighting the part of the timeline
    // currently in view: the visible fraction range, mapped onto the
    // minimap track (which always shows the whole timeline). When
    // the whole timeline is in view the box would cover the entire
    // minimap, so there is nothing to highlight: hide it. Re-run
    // whenever the view changes — zoom and resize via layoutLabels,
    // scrolling via the scroll listener below.
    function updateMinimapViewport() {
      const [visStart, visEnd] = visibleFracRange();
      if (visStart <= 0 && visEnd >= 1) {
        minimapViewport.style.display = 'none';
        return;
      }
      minimapViewport.style.display = '';
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      if (landscape) {
        minimapViewport.style.left = `${visStart * 100}%`;
        minimapViewport.style.width = `${(visEnd - visStart) * 100}%`;
      } else {
        minimapViewport.style.top = `${visStart * 100}%`;
        minimapViewport.style.height = `${(visEnd - visStart) * 100}%`;
      }
    }

    // A UTC date built with setUTCFullYear, so years 0-99 and
    // negative years are set as given instead of as 1900s.
    function utcDate(year, month, day) {
      const d = new Date(0);
      d.setUTCFullYear(year, month, day);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }

    // The boundaries of a time unit inside [fromMs, toMs]: seconds
    // at :00, minutes at :00, hours on the hour, days at midnight
    // UTC, months on the 1st, years on Jan 1, decades/centuries/
    // millennia on Jan 1 of the year starting the period. Fixed
    // units align to multiples of their duration since the epoch;
    // calendar units are walked month by month / year by year.
    function tickBoundaries(unitName, fromMs, toMs) {
      const out = [];
      if (unitName === 'second' || unitName === 'minute' || unitName === 'hour' || unitName === 'day') {
        const unit = TICK_UNITS.find((u) => u.name === unitName);
        let t = Math.ceil(fromMs / unit.ms) * unit.ms;
        for (; t <= toMs; t += unit.ms) {
          out.push(t);
        }
        return out;
      }
      const startDate = new Date(fromMs);
      const year = startDate.getUTCFullYear();
      const month = startDate.getUTCMonth();
      if (unitName === 'month') {
        // First day of this month, or next month if already past it.
        let d = utcDate(year, month, 1);
        if (d.getTime() < fromMs) {
          d = utcDate(year, month + 1, 1);
        }
        for (; d.getTime() <= toMs; d = utcDate(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) {
          out.push(d.getTime());
        }
        return out;
      }
      // year / decade / century / millennium: Jan 1 of the period's
      // first year.
      const span = unitName === 'year' ? 1 : unitName === 'decade' ? 10 : unitName === 'century' ? 100 : 1000;
      let firstYear = Math.floor(year / span) * span;
      let d = utcDate(firstYear, 0, 1);
      if (d.getTime() < fromMs) {
        d = utcDate(firstYear + span, 0, 1);
      }
      for (; d.getTime() <= toMs; d = utcDate(d.getUTCFullYear() + span, 0, 1)) {
        out.push(d.getTime());
      }
      return out;
    }

    // Fill the tick container with dashes for the visible range.
    // Re-run whenever the view changes — zoom and resize via
    // layoutLabels, scrolling via the scroll listener below.
    function updateTicks() {
      if (!ticksContainer || timelineEndMs <= timelineStartMs) {
        return;
      }
      ticksContainer.querySelectorAll('.timeline-tick').forEach((tick) => tick.remove());
      const [visStart, visEnd] = visibleFracRange();
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      const viewport = landscape ? window.innerWidth : window.innerHeight;
      const rangeMs = timelineEndMs - timelineStartMs;
      const visStartMs = timelineStartMs + visStart * rangeMs;
      const visEndMs = timelineStartMs + visEnd * rangeMs;
      const visSpanMs = visEndMs - visStartMs;
      if (visSpanMs <= 0) {
        return;
      }
      const pxPerMs = viewport / visSpanMs;
      for (const unit of TICK_UNITS) {
        if (unit.ms * pxPerMs < MIN_TICK_SPACING) {
          continue;
        }
        // One extra tick beyond each edge, so scrolling a little
        // does not immediately show a gap before the next
        // re-placement.
        const boundaries = tickBoundaries(unit.name, visStartMs - unit.ms, visEndMs + unit.ms);
        for (const time of boundaries) {
          const frac = (time - timelineStartMs) / rangeMs;
          if (frac < 0 || frac > 1) {
            continue;
          }
          const tick = document.createElement('div');
          tick.className = 'timeline-tick';
          tick.setAttribute('aria-hidden', 'true');
          tick.style.setProperty('--pos', `${frac * 100}%`);
          tick.style.setProperty('--tick-size', `${unit.size}px`);
          ticksContainer.appendChild(tick);
        }
      }
    }

    // Labels: one small box per event, title plus the first few words
    // of its description, floating above or below the line. There is
    // only room for some of them, so each label is placed greedily in
    // time order into the first of two lanes (above, then below) where
    // it fits without overlapping a label already there; the rest are
    // suppressed. Placement depends on pixel widths, so it is redone
    // whenever the zoom or the window size changes.
    // One label box for an event: title plus the first few words
    // of its description, with a border in the event's colour.
    // Events without a colour keep the default grey border.
    function makeLabel(event) {
      const label = document.createElement('div');
      label.className = 'event-label';
      label.setAttribute('aria-hidden', 'true');
      const title = document.createElement('div');
      title.className = 'event-label-title';
      title.textContent = event.title;
      label.appendChild(title);
      if (event.description) {
        const words = event.description.split(/\s+/);
        const excerpt = document.createElement('div');
        excerpt.className = 'event-label-excerpt';
        excerpt.textContent = words.slice(0, 8).join(' ') + (words.length > 8 ? '…' : '');
        label.appendChild(excerpt);
      }
      if (event.style && event.style.color) {
        label.style.borderColor = event.style.color;
      }
      return label;
    }

    function layoutLabels() {
      track.querySelectorAll('.event-label').forEach((label) => label.remove());
      if (!labelTargets.length) {
        return;
      }
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      const trackLength = landscape ? track.offsetWidth : track.offsetHeight;
      const lanes = [[], []];

      labelTargets.forEach(({ event, frac, startFrac, endFrac }) => {
        const label = makeLabel(event);
        label.style.setProperty('--pos', `${frac}%`);
        track.appendChild(label);
        // A duration event's label is clickable too, and snaps the
        // zoom the same way its bar does. Other labels stay
        // click-through (see .event-label), so they never swallow a
        // click meant for something beneath them.
        if (event.end) {
          label.style.pointerEvents = 'auto';
          label.style.cursor = 'pointer';
          label.addEventListener('click', () => zoomToRange(startFrac, endFrac));
        }
        const size = landscape ? label.offsetWidth : label.offsetHeight;
        const centre = (frac / 100) * trackLength;
        const interval = [centre - size / 2 - LABEL_GAP, centre + size / 2 + LABEL_GAP];
        const lane = lanes.findIndex((placed) => placed.every(([from, to]) => interval[1] <= from || interval[0] >= to));
        if (lane === -1) {
          label.remove();
          return;
        }
        lanes[lane].push(interval);
        label.classList.add(lane === 0 ? 'label-above' : 'label-below');
      });
      placedLanes = lanes;
      updateOffscreenLabels();
      updateMinimapViewport();
      updateTicks();
    }

    // The fraction of the timeline currently on screen, clamped
    // to the timeline itself (the end padding shows no events).
    function visibleFracRange() {
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      const rect = track.getBoundingClientRect();
      const trackLength = landscape ? rect.width : rect.height;
      if (!trackLength) {
        return [0, 1];
      }
      const scroll = landscape ? window.scrollX : window.scrollY;
      const viewport = landscape ? window.innerWidth : window.innerHeight;
      const trackStart = (landscape ? rect.left : rect.top) + scroll;
      const start = Math.min(1, Math.max(0, (scroll - trackStart) / trackLength));
      const end = Math.min(1, Math.max(0, (scroll + viewport - trackStart) / trackLength));
      return [start, end];
    }

    // Labels for the closest events off screen: at most one pinned
    // at each edge of the viewport, so a zoomed-in stretch of empty
    // timeline still shows what lies beyond it in each direction.
    // An off-screen label is an ordinary label box for the event,
    // with a chevron pointing at the edge its event lies beyond; it
    // takes the first lane where it fits without overlapping an
    // on-screen label, and is suppressed if neither lane has room.
    // Clicking it zooms out just enough that the events already on
    // screen stay in view and this event comes into view too.
    function updateOffscreenLabels() {
      track.querySelectorAll('.offscreen-label').forEach((label) => label.remove());
      if (!labelTargets.length) {
        return;
      }
      const [visStart, visEnd] = visibleFracRange();
      let before = null;
      let after = null;
      for (const target of labelTargets) {
        const frac = target.frac / 100;
        if (frac < visStart && (!before || frac > before.frac / 100)) {
          before = target;
        } else if (frac > visEnd && (!after || frac < after.frac / 100)) {
          after = target;
        }
      }
      // A fresh copy of the on-screen lanes for this placement
      // round, so the two edge labels do not overlap each other
      // but their intervals are forgotten afterwards.
      const lanes = placedLanes.map((lane) => [...lane]);
      placeOffscreenLabel(before, -1, lanes);
      placeOffscreenLabel(after, 1, lanes);
    }

    function placeOffscreenLabel(target, direction, lanes) {
      if (!target) {
        return;
      }
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      const rect = track.getBoundingClientRect();
      const trackLength = landscape ? rect.width : rect.height;
      if (!trackLength) {
        return;
      }
      const scroll = landscape ? window.scrollX : window.scrollY;
      const viewport = landscape ? window.innerWidth : window.innerHeight;
      const trackStart = (landscape ? rect.left : rect.top) + scroll;
      const label = makeLabel(target.event);
      label.classList.add('offscreen-label', direction < 0 ? 'offscreen-before' : 'offscreen-after');
      label.style.pointerEvents = 'auto';
      label.style.cursor = 'pointer';
      label.addEventListener('click', () => {
        const [visStart, visEnd] = visibleFracRange();
        const startFrac = target.startFrac ?? target.frac / 100;
        const endFrac = target.endFrac ?? target.frac / 100;
        zoomToRange(Math.min(visStart, startFrac), Math.max(visEnd, endFrac));
      });
      track.appendChild(label);
      // Position it at the viewport edge: measure its size first,
      // then set --pos so its outer edge sits a small gap inside
      // the viewport.
      const size = landscape ? label.offsetWidth : label.offsetHeight;
      const edgeGap = 8;
      const edgePx = direction < 0
        ? scroll + edgeGap + size / 2
        : scroll + viewport - edgeGap - size / 2;
      const centre = edgePx - trackStart;
      label.style.setProperty('--pos', `${(centre / trackLength) * 100}%`);
      const interval = [centre - size / 2 - LABEL_GAP, centre + size / 2 + LABEL_GAP];
      const lane = lanes.findIndex((placed) => placed.every(([from, to]) => interval[1] <= from || interval[0] >= to));
      if (lane === -1) {
        label.remove();
        return;
      }
      lanes[lane].push(interval);
      label.classList.add(lane === 0 ? 'label-above' : 'label-below');
    }

    window.addEventListener('resize', () => layoutLabels());

    // Scrolling moves the viewport along the timeline, so the
    // closest off-screen events change; re-place their labels as
    // the user scrolls. Only the off-screen labels move — the
    // on-screen ones are positioned along the track, so their
    // layout is unaffected.
    let offscreenRaf = 0;
    window.addEventListener('scroll', () => {
      if (offscreenRaf) {
        return;
      }
      offscreenRaf = requestAnimationFrame(() => {
        offscreenRaf = 0;
        updateOffscreenLabels();
        updateMinimapViewport();
        updateTicks();
      });
    }, { passive: true });

    console.log('Loading timeline…');

    fetchTimeline(TIMELINE_URL)
      .then((data) => {
        timeline = data;
        console.log('Loaded timeline:', data.title, `(${data.events.length} events)`);
        drawEvents(data.events);
        // The tick container, created after the dots and bars so it
        // paints above them (labels, appended later, paint above it).
        ticksContainer = document.createElement('div');
        ticksContainer.className = 'timeline-ticks';
        ticksContainer.setAttribute('aria-hidden', 'true');
        track.appendChild(ticksContainer);
        drawMinimap(data.events);
        computeMaxZoom(data.events);
        layoutLabels();
      })
      .catch((error) => {
        console.error('Could not load timeline:', error);
      });
