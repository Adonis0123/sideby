// The Menu Bar Item's process (spec §3.31, ADR-0034): JXA run by the system's `osascript`, with no compiled code. It
// draws what `sideby menubar snapshot --json` says and turns clicks into sideby commands; it reads no other file and
// decides nothing itself. Arguments: the Node binary and the sideby entry the LaunchAgent recorded.
import { MENUBAR_ICON_PNG } from '../core/brand-mark.ts'
import { MENUBAR_STRINGS } from './strings.ts'

/** Seconds between two snapshots, and between two looks at a running one. */
export const SNAPSHOT_SECONDS = 120
export const TICK_SECONDS = 5
/** A snapshot older than this greys the title. */
export const STALE_SECONDS = 15 * 60
/** A snapshot still running after this is ended, so a stuck one cannot stop the refreshes. */
export const SNAPSHOT_TIMEOUT_SECONDS = 60
/**
 * While a manual refresh runs, a cache-only snapshot (`--cached`) every this many seconds, so each account's new
 * numbers show as soon as its answer is kept instead of all at once at the end (spec §3.31).
 */
export const PEEK_SECONDS = 2
/**
 * Hours after which an idle item starts itself again. Over many hours the menu took longer and longer to open (1.6 to
 * 2 s after 18 hours on macOS 27, 2026-10-30, against about 0.1 s fresh), with no cause found in the script.
 */
export const RESTART_HOURS = 6
/** The macOS distributed notification that makes a running item read its snapshot again (`nudgeMenubar`). */
export const MENUBAR_RELOAD = 'dev.sideby.menubar.reload'

export const MENUBAR_SCRIPT = String.raw`
ObjC.import('Cocoa');
ObjC.import('Carbon');
ObjC.import('stdlib');
function run(argv) {
  var node = argv[0], entry = argv[1];
  var SNAPSHOT = ${SNAPSHOT_SECONDS}, TICK = ${TICK_SECONDS}, STALE = ${STALE_SECONDS}, TIMEOUT = ${SNAPSHOT_TIMEOUT_SECONDS}, PEEK = ${PEEK_SECONDS};
  var lang = 'en';
  try { lang = ObjC.unwrap($.NSLocale.preferredLanguages.firstObject) || 'en'; } catch (e) {}
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var item = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
  // Keeps the place a user drags it to with Command held, such as out from under the notch.
  item.autosaveName = 'dev.sideby.menubar';
  // Sai, the painted sideby buddy, in colour (core/brand-mark.ts); a system gauge, drawn as a template, if it cannot load.
  var MARK_PNG = ${JSON.stringify(MENUBAR_ICON_PNG)};
  var icon = pngImage(MARK_PNG, 18);
  if (!icon) {
    icon = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription('gauge.with.needle', 'sideby');
    if (icon && !icon.isNil()) icon.template = true;
  }
  if (icon && !icon.isNil()) {
    icon.accessibilityDescription = 'sideby';
    item.button.image = icon;
    item.button.imagePosition = $.NSImageLeft;
  } else item.button.title = 'sideby';

  var out = ObjC.unwrap($.NSTemporaryDirectory()) + 'sideby-menubar-' + $.NSProcessInfo.processInfo.processIdentifier + '.json';
  var snap = null, task = null, handle = null, lastStart = 0, lastOk = 0, failed = false;
  var refs = [], actions = [], footer = null, appearance = '', manual = false;
  // The first words, before any snapshot has said which language to use.
  var zh = /^zh/i.test(lang);
  var LOADING = zh ? ${JSON.stringify(MENUBAR_STRINGS.zh.loading)} : ${JSON.stringify(MENUBAR_STRINGS.en.loading)};
  var OPEN_PANEL = zh ? ${JSON.stringify(MENUBAR_STRINGS.zh.openPanel)} : ${JSON.stringify(MENUBAR_STRINGS.en.openPanel)};
  var now = function () { return Date.now() / 1000; };
  // The clock NSEvent timestamps use.
  var uptime = function () { return Number($.NSProcessInfo.processInfo.systemUptime); };
  var started = now();

  function sideby(args) {
    var t = $.NSTask.alloc.init;
    t.executableURL = $.NSURL.fileURLWithPath(node);
    t.arguments = $([entry].concat(args));
    t.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;
    t.standardError = $.NSFileHandle.fileHandleWithNullDevice;
    return t;
  }
  function act(args) {
    var t = sideby(args);
    if (t.launchAndReturnError(null)) actions.push(t);
  }
  var forceNext = false;
  // While a manual refresh runs: when it started (ISO, for --refreshing-since) and the cache-only snapshot in flight.
  var refreshSince = '', peekTask = null, peekHandle = null, peekOut = out + '.peek';
  function startSnapshot(force) {
    if (task) { if (force) forceNext = true; return; }
    force = force || forceNext;
    forceNext = false;
    if (force) refreshSince = new Date().toISOString();
    $.NSFileManager.defaultManager.createFileAtPathContentsAttributes(out, $(), $());
    hotkeyReported = hotkeyReport();
    iconReported = iconStable;
    var t = sideby(['menubar', 'snapshot', '--json', '--lang', lang].concat(force ? ['--refresh'] : [], hotkeyReported ? ['--hotkey', hotkeyStatus, '--hotkey-label', hotkeyWant.label] : [], iconReported ? ['--icon', iconReported] : []));
    handle = $.NSFileHandle.fileHandleForWritingAtPath(out);
    t.standardOutput = handle;
    lastStart = now();
    if (t.launchAndReturnError(null)) task = t;
    else { failed = true; closeHandle(); }
  }
  function closeHandle() {
    if (handle) { handle.closeFile; handle = null; }
  }
  // The snapshot a finished task wrote, or null.
  function readSnapshot(path) {
    try {
      var next = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null)));
      return next && next.schemaVersion === 1 ? next : null;
    } catch (e) { return null; }
  }
  function finishSnapshot() {
    var ok = task.terminationStatus === 0;
    task = null;
    // A refresh asked for while an automatic read ran starts next; it stays a manual one.
    if (!forceNext) manual = false;
    closeHandle();
    // The refresh's own result wins: a cache-only snapshot still running started before it and is dropped.
    stopPeek();
    var next = ok ? readSnapshot(out) : null;
    if (next) { snap = next; lastOk = now(); failed = false; hotkey(snap.hotkey); build(); return; }
    failed = true;
    // A cache-only snapshot may have marked rows as refreshing; nothing is refreshing any more.
    if (snap) (snap.sections || []).forEach(function (s) {
      s.rows.concat(s.more ? s.more.rows : []).forEach(function (r) {
        if (!r.refreshing) return;
        var says = snap.lang === 'zh' ? ${JSON.stringify(MENUBAR_STRINGS.zh.rowRefreshFailed)} : ${JSON.stringify(MENUBAR_STRINGS.en.rowRefreshFailed)};
        r.refreshing = false; r.refreshFailed = true; r.reset = r.resetTime = says;
        (r.groups || []).forEach(function (g) { g.reset = g.resetTime = says; });
      });
    });
    build();
  }
  // During a manual refresh, a cache-only snapshot that never asks a Host: accounts already answered show their new
  // numbers, the others say they are refreshing. At most one runs at a time.
  function peek() {
    if (task && !task.running) { finishSnapshot(); return; }
    if (peekTask && !peekTask.running) {
      var ok = peekTask.terminationStatus === 0;
      peekTask = null;
      closePeek();
      var next = ok && task && manual ? readSnapshot(peekOut) : null;
      if (next) { snap = next; build(); }
    }
    if (peekTask || !task || !manual || !refreshSince) return;
    $.NSFileManager.defaultManager.createFileAtPathContentsAttributes(peekOut, $(), $());
    var t = sideby(['menubar', 'snapshot', '--json', '--cached', '--refreshing-since', refreshSince, '--lang', lang]);
    peekHandle = $.NSFileHandle.fileHandleForWritingAtPath(peekOut);
    t.standardOutput = peekHandle;
    if (t.launchAndReturnError(null)) peekTask = t;
    else closePeek();
  }
  function closePeek() {
    if (peekHandle) { peekHandle.closeFile; peekHandle = null; }
  }
  function stopPeek() {
    if (peekTask && peekTask.running) peekTask.terminate;
    peekTask = null;
    closePeek();
  }

  // The shortcut that toggles the menu from anywhere (config menubar.hotkey), registered with Carbon's
  // RegisterEventHotKey: it needs no permission, unlike watching every key press. macOS hands a press to this app as a
  // system-defined event of subtype 6 whose data1 is the key's reference. While the menu is open the key is
  // unregistered, so the press reaches the menu, where a hidden item with the same key closes it.
  var hotkeyWant = null, hotkeyRef = 0, hotkeyBound = false, menuOpen = false, closedAt = 0, lastUse = 0;
  // Whether the shortcut could be registered ('ok', 'taken', '' when off), and what the last snapshot was told: the
  // status with the shortcut it is about, so a report never lands on a shortcut changed since.
  var hotkeyStatus = '', hotkeyReported = '';
  function hotkeyReport() { return hotkeyStatus && hotkeyWant ? hotkeyStatus + ' ' + hotkeyWant.label : ''; }
  function bindHotkeyFunctions() {
    if (hotkeyBound) return;
    ObjC.bindFunction('GetApplicationEventTarget', ['void *', []]);
    ObjC.bindFunction('RegisterEventHotKey', ['int', ['unsigned int', 'unsigned int', 'unsigned long long', 'void *', 'unsigned int', 'void *']]);
    ObjC.bindFunction('UnregisterEventHotKey', ['int', ['unsigned long long']]);
    watchKeys();
    hotkeyBound = true;
  }
  // The bridge hands AppKit a JSValue for whatever the handler returns, never the event, so AppKit throws on every
  // system-defined event that passes. The main loop swallows that; a modal loop (an NSAlert) throws it out of
  // runModal. So the monitor is lifted while an alert is up (pauseKeys), and put back after (watchKeys).
  var monitor = null;
  function watchKeys() {
    if (monitor) return;
    monitor = $.NSEvent.addLocalMonitorForEventsMatchingMaskHandler($.NSEventMaskSystemDefined, function (e) {
      // A press made before the menu closed meant "close", not "open again"; any later press opens it at once.
      if (e.subtype === 6 && hotkeyRef && Number(e.data1) === hotkeyRef && !menuOpen && Number(e.timestamp) > closedAt) openMenu();
      return e;
    });
  }
  function pauseKeys() {
    if (monitor) { $.NSEvent.removeMonitor(monitor); monitor = null; }
    try { unregisterHotkey(); } catch (e) {}
  }
  function resumeKeys() {
    if (!hotkeyBound) return;
    watchKeys();
    try { registerHotkey(); } catch (e) {}
  }
  // Whether macOS shows the icon now: 'visible', 'hidden' (behind « in a full menu bar, or covered), or '' while the
  // menu bar itself is hidden (a full-screen app), when nothing can be said. The Panel says where it went.
  var iconSeen = '', iconStable = '', iconReported = '';
  function iconNow() {
    if (!$.NSMenu.menuBarVisible) return '';
    var w = item.button.window;
    if (!w || w.isNil()) return '';
    return Number(w.occlusionState) & Number($.NSWindowOcclusionStateVisible) ? 'visible' : 'hidden';
  }
  // Two looks in a row agree before it counts, so a moment of change (a Space switch) is not reported.
  function lookAtIcon() {
    var seen = iconNow();
    if (seen && seen === iconSeen) iconStable = seen;
    iconSeen = seen;
  }
  // Drops the menu from the icon when it shows; at the pointer when the icon is hidden, such as by a full menu bar or
  // under the notch, where clicking it would do nothing.
  function openMenu() {
    var w = item.button.window;
    if (w && !w.isNil() && (w.occlusionState & $.NSWindowOcclusionStateVisible)) { item.button.performClick(null); return; }
    app.activateIgnoringOtherApps(true);
    item.menu.popUpMenuPositioningItemAtLocationInView(null, $.NSEvent.mouseLocation, null);
    app.deactivate;
  }
  function registerHotkey() {
    if (hotkeyRef || !hotkeyWant) return;
    var buf = $.NSMutableData.dataWithLength(8);
    // EventHotKeyID { OSType signature 'sdby'; UInt32 id 1 } is passed in one register, the id in the high half.
    // Not 0: another app or macOS holds the key (eventHotKeyExistsErr); the menu and the Panel say so.
    if ($.RegisterEventHotKey(hotkeyWant.keyCode, hotkeyWant.modifiers, 4294967296 + 0x73646279, $.GetApplicationEventTarget(), 0, buf.mutableBytes) !== 0) { hotkeyStatus = 'taken'; return; }
    hotkeyStatus = 'ok';
    // The EventHotKeyRef the call wrote, read back from the buffer as a little-endian number.
    var hex = (ObjC.unwrap(buf.description).match(/0x([0-9a-f]{16})/i) || ['', ''])[1];
    var ref = 0;
    for (var i = 7; i >= 0; i--) ref = ref * 256 + parseInt(hex.substr(i * 2, 2), 16);
    hotkeyRef = ref || 0;
  }
  function unregisterHotkey() {
    if (hotkeyRef) $.UnregisterEventHotKey(hotkeyRef);
    hotkeyRef = 0;
  }
  function hotkey(h) {
    var key = function (x) { return x ? x.keyCode + ':' + x.modifiers : ''; };
    if (key(h) === key(hotkeyWant) && (hotkeyRef || !h || menuOpen)) return;
    try {
      bindHotkeyFunctions();
      unregisterHotkey();
      hotkeyWant = h || null;
      if (!hotkeyWant) hotkeyStatus = '';
      if (!menuOpen) registerHotkey();
    } catch (e) {}
  }
  // The hidden item that closes the open menu with the same key; Carbon modifier flags to Cocoa ones.
  function closeItem(menu) {
    if (!hotkeyWant) return;
    var flags = { 4096: 1 << 18, 2048: 1 << 19, 512: 1 << 17, 256: 1 << 20 }, mask = 0;
    Object.keys(flags).forEach(function (f) { if (hotkeyWant.modifiers & Number(f)) mask += flags[f]; });
    var mi = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent('sideby', 'closeMenu:', hotkeyWant.label.slice(-1).toLowerCase());
    mi.keyEquivalentModifierMask = mask;
    mi.target = target;
    mi.hidden = true;
    mi.allowsKeyEquivalentWhenHidden = true;
    menu.addItem(mi);
  }

  function color(level) {
    if (level === 'fail') return $.NSColor.systemRedColor;
    if (level === 'warn') return $.NSColor.systemOrangeColor;
    if (level === 'stale') return $.NSColor.secondaryLabelColor;
    return null;
  }
  function attrs(c, font, para) {
    var d = $.NSMutableDictionary.dictionary;
    if (c) d.setObjectForKey(c, $.NSForegroundColorAttributeName);
    if (font) d.setObjectForKey(font, $.NSFontAttributeName);
    if (para) d.setObjectForKey(para, $.NSParagraphStyleAttributeName);
    return d;
  }
  function str(text, d) {
    // The bridge lacks initWithString:attributes: (no BridgeSupport entry), so it is sent by name.
    return $.NSAttributedString.alloc.performSelectorWithObjectWithObject('initWithString:attributes:', $(text), d);
  }
  function styled(text, c) { return str(text, attrs(c, null, null)); }
  function width(text, font) { return str(text, attrs(null, font, null)).size.width; }
  // Old numbers, or the last refresh failed: they may no longer be true, so they are drawn grey.
  function stale() { return !snap || failed || now() - lastOk > STALE; }
  function drawTitle() {
    var text = snap && snap.title ? ' ' + snap.title : '';
    item.button.attributedTitle = styled(text, stale() ? color('stale') : color(snap && snap.level));
    if (snap) item.button.toolTip = snap.tooltip;
  }
  function footerText() {
    if (!snap) return LOADING;
    var l = snap.labels;
    if (task && (manual || !lastOk)) return l.refreshing;
    if (failed) return l.refreshFailed;
    var minutes = Math.floor((now() - lastOk) / 60);
    return minutes < 1 ? l.updatedJustNow : l.updatedMinutes.replace('{n}', String(minutes));
  }
  function add(menu, title, action, tag, key) {
    var mi = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, action || null, key || '');
    if (action) { mi.target = target; mi.tag = tag || 0; } else mi.enabled = false;
    menu.addItem(mi);
    return mi;
  }
  function header(menu, title) {
    if ($.NSMenuItem.respondsToSelector('sectionHeaderWithTitle:')) menu.addItem($.NSMenuItem.sectionHeaderWithTitle(title));
    else add(menu, title, null);
  }

  function dark() {
    var best = app.effectiveAppearance.bestMatchFromAppearancesWithNames($([$.NSAppearanceNameAqua, $.NSAppearanceNameDarkAqua]));
    return ObjC.unwrap(best) === ObjC.unwrap($.NSAppearanceNameDarkAqua);
  }
  function hex(h) {
    var n = parseInt(h.slice(1), 16);
    return $.NSColor.colorWithSRGBRedGreenBlueAlpha((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, 1);
  }
  // The Panel's quota colours (page-styles.ts): bars by level on a soft track, so both look alike.
  var BAR = { ok: '#22c55e', warn: '#f59e0b', fail: '#ef4444' };
  function svgImage(svg, size, template) {
    var img = $.NSImage.alloc.initWithData($(svg).dataUsingEncoding($.NSUTF8StringEncoding));
    if (!img || img.isNil() || !img.isValid) return null;
    img.size = $.NSMakeSize(size, size);
    img.template = template;
    return img;
  }
  // A base64 PNG at size×size points; null when macOS cannot read it.
  function pngImage(b64, size) {
    var data = $.NSData.alloc.initWithBase64EncodedStringOptions($(b64), 0);
    if (!data || data.isNil()) return null;
    var img = $.NSImage.alloc.initWithData(data);
    if (!img || img.isNil() || !img.isValid) return null;
    img.size = $.NSMakeSize(size, size);
    return img;
  }
  function symbol(name) {
    var img = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription(name, name);
    return img && !img.isNil() ? img : null;
  }
  function logoImage(logo) {
    if (!logo) return null;
    // In its brand colour like the Panel, else in the text colour of this appearance. Painted here, not as a template:
    // headers cannot be clicked, and macOS greys a template image on an item that cannot be clicked.
    var rule = logo.fillRule ? ' fill-rule="' + logo.fillRule + '"' : '';
    var fill = /^#[0-9a-f]{3,8}$/i.test(logo.color || '') ? logo.color : dark() ? '#f5f5f7' : '#1d1d1f';
    // A multicoloured mark: the shape again per wash, each filled with a gradient that fades out. Only numbers and
    // hex colours reach the markup.
    var defs = '', washes = '';
    (logo.gradients || []).forEach(function (g, i) {
      var n = [g.from[0], g.from[1], g.to[0], g.to[1]].map(Number);
      if (!n.every(isFinite) || !/^#[0-9a-f]{3,8}$/i.test(g.color || '')) return;
      defs += '<linearGradient id="w' + i + '" gradientUnits="userSpaceOnUse" x1="' + n[0] + '" y1="' + n[1] + '" x2="' + n[2] + '" y2="' + n[3] + '"><stop offset="0" stop-color="' + g.color + '"/><stop offset="1" stop-color="' + g.color + '" stop-opacity="0"/></linearGradient>';
      washes += '<path' + rule + ' fill="url(#w' + i + ')" d="' + logo.path + '"/>';
    });
    return svgImage('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14">' + (defs ? '<defs>' + defs + '</defs>' : '') + '<path' + rule + ' fill="' + fill + '" d="' + logo.path + '"/>' + washes + '</svg>', 14, false);
  }

  var GUTTER = $.NSImage.alloc.initWithSize($.NSMakeSize(14, 14));
  // Model group lines sit a little in from their account's name.
  var GROUP_INDENT = '\u2003';
  // Where a menu item draws its image and its title (macOS 26 and 27), for the header views that line up with them.
  var HEAD_X = 15, HEAD_TEXT_X = 34;

  // A quota window as a small rounded bar: a soft track, filled as far as it is used, coloured by level.
  // Drawn once per fill and colour and kept until light or dark mode changes, so a refresh draws none again.
  var BAR_W = 44, BAR_H = 5, bars = {}, barsDark = null;
  function bar(b, old) {
    var d = dark(), fill = stale() || old ? 'old' : BAR[b.level] || BAR.ok, pct = Math.max(0, Math.min(100, b.percent));
    if (d !== barsDark) { bars = {}; barsDark = d; }
    var key = pct + fill;
    if (bars[key]) return bars[key];
    var img = $.NSImage.alloc.initWithSize($.NSMakeSize(BAR_W, BAR_H));
    img.lockFocus;
    hex(d ? '#1f2c3a' : '#e4edf4').set;
    $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(0, 0, BAR_W, BAR_H), BAR_H / 2, BAR_H / 2).fill;
    if (pct > 0) {
      (fill === 'old' ? $.NSColor.tertiaryLabelColor : hex(fill)).set;
      var w = Math.max(BAR_H, BAR_W * pct / 100);
      $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(0, 0, w, BAR_H), BAR_H / 2, BAR_H / 2).fill;
    }
    img.unlockFocus;
    var att = $.NSTextAttachment.alloc.init;
    att.image = img;
    att.bounds = $.NSMakeRect(0, 1.5, BAR_W, BAR_H);
    return (bars[key] = $.NSAttributedString.attributedStringWithAttachment(att));
  }

  var keptW = { name: 0, reset: 0, tag: 0 };
  // Columns: the name, then per window its bar and percent, then the reset time. One set of tab stops lines them up
  // across every tool; the window names sit once in each tool's header, over their column. A tool with one window
  // draws it in the second column, under the others' long window.
  function layout(sections) {
    var size = $.NSFont.menuFontOfSize(0).pointSize;
    var L = {
      font: $.NSFont.menuFontOfSize(size),
      mono: $.NSFont.monospacedDigitSystemFontOfSizeWeight(size, 0),
      head: $.NSFont.systemFontOfSizeWeight(size - 2, $.NSFontWeightSemibold),
      small: $.NSFont.systemFontOfSize(size - 2),
    };
    // The reset column names its window ("7d", then "tomorrow 4:59 PM"), so it is as wide as its longest entry. While the
    // menu is open it never gets narrower, so rows changing during a refresh do not make the menu jump.
    // The times start at one tab stop after the widest window tag, so 7d and 31d rows line their times up.
    var nameW = 0, first = false, tagW = width('7d', L.font), timeW = width('Wed 12:59 PM', L.font), plainW = 0;
    function measure(r) {
      var c = resetCell(r);
      if (c[0]) { tagW = Math.max(tagW, width(c[0], L.font)); timeW = Math.max(timeW, width(c[1], L.font)); }
      else plainW = Math.max(plainW, width(c[1], L.font));
    }
    sections.forEach(function (s) {
      nameW = Math.max(nameW, width(s.title, L.head));
      if (s.columns[0]) first = true;
      s.rows.concat(s.more ? s.more.rows : []).forEach(function (r) {
        nameW = Math.max(nameW, width(r.label, L.font));
        if (r.bars) measure(r);
        (r.groups || []).forEach(function (g) {
          nameW = Math.max(nameW, width(GROUP_INDENT + g.label, L.font));
          measure({ reset: g.reset, resetLabel: g.resetLabel, resetTime: g.resetTime, refreshing: r.refreshing, refreshFailed: r.refreshFailed, stale: r.stale, note: g.reset });
        });
      });
    });
    tagW = Math.ceil(tagW) + 8;
    var resetW = Math.max(tagW + timeW, plainW);
    if (menuOpen) { nameW = Math.max(nameW, keptW.name); resetW = Math.max(resetW, keptW.reset); tagW = Math.max(tagW, keptW.tag); }
    keptW = { name: nameW, reset: resetW, tag: tagW };
    var pctW = width('100%', L.mono), x = Math.ceil(nameW) + 20, stops = [], at = [];
    function tab(pos) { stops.push($.NSTextTab.alloc.initWithTextAlignmentLocationOptions($.NSTextAlignmentLeft, pos, $())); }
    for (var c = 0; c < (first ? 2 : 1); c++) {
      at.push(x);
      tab(x); x += BAR_W + 7;
      tab(x); x += pctW + 20;
    }
    tab(x);
    tab(x + tagW);
    L.reset = x;
    L.first = first;
    L.para = $.NSMutableParagraphStyle.alloc.init;
    L.para.tabStops = $(stops);
    // The header has a tab stop at each bar and at the reset column, for its window names.
    L.headPara = $.NSMutableParagraphStyle.alloc.init;
    L.headPara.tabStops = $(at.concat([x]).map(function (pos) {
      return $.NSTextTab.alloc.initWithTextAlignmentLocationOptions($.NSTextAlignmentLeft, pos, $());
    }));
    L.width = x + resetW + 70;
    return L;
  }
  // The reset cell: [window tag, time]. The tag is drawn grey and the time in the text colour; a cell that says
  // something else (refreshing, failed, an old reading, every window past its reset) has only grey words.
  function resetCell(r) {
    if (r.refreshing || r.refreshFailed) return ['', r.resetTime || r.reset || ''];
    if (r.stale) return ['', r.note || ''];
    if (r.resetLabel) return [r.resetLabel, r.resetTime];
    return ['', r.reset || ''];
  }
  function rowTitle(r, L) {
    var line = $.NSMutableAttributedString.alloc.init;
    var plain = attrs(null, L.font, L.para), dim = attrs($.NSColor.secondaryLabelColor, L.font, L.para);
    line.appendAttributedString(str(r.label, plain));
    if (!r.bars) {
      line.appendAttributedString(str('\t' + r.note, dim));
      return line;
    }
    r.bars.forEach(function (b, i) {
      if (!i && !L.first) return;
      if (!b) { line.appendAttributedString(str('\t\t', plain)); return; }
      line.appendAttributedString(str('\t', plain));
      // A window past its reset keeps its old bar in grey, with no percent: the reading no longer says how much is used.
      line.appendAttributedString(bar(b, r.stale || b.passed));
      var c = stale() || r.stale || b.passed ? color('stale') : b.level === 'ok' ? null : color(b.level);
      line.appendAttributedString(str('\t' + (b.passed ? '–' : b.percent + '%'), attrs(c, L.mono, L.para)));
    });
    var cell = resetCell(r);
    if (cell[0]) {
      line.appendAttributedString(str('\t' + cell[0], dim));
      line.appendAttributedString(str('\t' + cell[1], stale() ? dim : plain));
    } else if (cell[1]) line.appendAttributedString(str('\t' + cell[1], dim));
    return line;
  }
  function accountItem(menu, r, L) {
    refs.push(r.ref);
    var mi = add(menu, r.label, 'start:', refs.length);
    mi.attributedTitle = rowTitle(r, L);
    // An empty image as wide as the tools' logos, so every row's text starts where the headers' text does and the
    // window names sit over their bars.
    mi.image = GUTTER;
    mi.toolTip = r.tip;
    if (r.recommended) {
      if (mi.respondsToSelector('setBadge:')) mi.badge = $.NSMenuItemBadge.alloc.initWithString(snap.labels.recommended);
      else {
        var t = $.NSMutableAttributedString.alloc.initWithAttributedString(mi.attributedTitle);
        t.appendAttributedString(styled('  ' + snap.labels.recommended, $.NSColor.controlAccentColor));
        mi.attributedTitle = t;
      }
    }
    // A Host that gives each model group its own limits: a line per group under the account, with that group's bars.
    // Clicking one starts the same account.
    (r.groups || []).forEach(function (g) {
      refs.push(r.ref);
      var gi = add(menu, g.label, 'start:', refs.length);
      gi.attributedTitle = rowTitle({ label: GROUP_INDENT + g.label, bars: g.bars, reset: g.reset, resetLabel: g.resetLabel, resetTime: g.resetTime, refreshing: r.refreshing, refreshFailed: r.refreshFailed, stale: r.stale, note: g.reset }, L);
      gi.image = GUTTER;
      gi.toolTip = g.tip;
    });
    return mi;
  }
  // A tool's header: its mark, its name, and the window names over the bar columns. A view, not a title: macOS dims
  // the title of an item that cannot be clicked whatever its colour, which made every tool's name look disabled. The
  // mark and the text sit where an item's image and title do, so the window names stay over their bars.
  function sectionHeader(menu, s, L) {
    var line = $.NSMutableAttributedString.alloc.init;
    line.appendAttributedString(str(s.title, attrs($.NSColor.labelColor, L.head, L.headPara)));
    var cols = L.first ? s.columns : [s.columns[1]];
    cols.forEach(function (c) { line.appendAttributedString(str('\t' + (c || ''), attrs($.NSColor.secondaryLabelColor, L.small, L.headPara))); });
    if (s.rows.some(function (r) { return r.reset || r.refreshing || r.refreshFailed || (r.groups || []).some(function (g) { return g.reset; }); }))
      line.appendAttributedString(str('\t' + snap.labels.resetsHeader, attrs($.NSColor.secondaryLabelColor, L.small, L.headPara)));
    var W = Math.max(280, L.width), H = 24;
    var v = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    v.autoresizingMask = $.NSViewWidthSizable;
    var logo = logoImage(s.logo);
    if (logo) {
      var iv = $.NSImageView.imageViewWithImage(logo);
      iv.frame = $.NSMakeRect(HEAD_X, (H - 14) / 2, 14, 14);
      v.addSubview(iv);
    }
    var text = $.NSTextField.labelWithAttributedString(line);
    text.frame = $.NSMakeRect(HEAD_TEXT_X, (H - 16) / 2, W - HEAD_TEXT_X - 10, 16);
    v.addSubview(text);
    var mi = $.NSMenuItem.alloc.init;
    mi.view = v;
    menu.addItem(mi);
  }
  // The card at the top: Sai, a bold status, and a grey line naming the account the status is about.
  function card(menu, c, L) {
    var W = Math.max(280, L.width), H = 50;
    var v = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    v.autoresizingMask = $.NSViewWidthSizable;
    var icon = pngImage(MARK_PNG, 30);
    if (icon) {
      var iv = $.NSImageView.imageViewWithImage(icon);
      iv.frame = $.NSMakeRect(14, 10, 30, 30);
      v.addSubview(iv);
    }
    var status = $.NSTextField.labelWithString(c.status);
    status.font = $.NSFont.systemFontOfSizeWeight(13, $.NSFontWeightSemibold);
    status.textColor = (stale() ? color('stale') : color(c.level)) || $.NSColor.labelColor;
    status.frame = $.NSMakeRect(54, 25, W - 64, 17);
    var detail = $.NSTextField.labelWithString(c.detail);
    detail.font = $.NSFont.systemFontOfSize(11);
    detail.textColor = $.NSColor.secondaryLabelColor;
    detail.frame = $.NSMakeRect(54, 9, W - 64, 15);
    v.addSubview(status);
    v.addSubview(detail);
    var mi = $.NSMenuItem.alloc.init;
    mi.view = v;
    menu.addItem(mi);
  }
  function withImage(mi, name) {
    var img = symbol(name);
    if (img) mi.image = img;
    return mi;
  }
  // The last line: when the numbers were checked, and a refresh button. A button in a view keeps the menu open, so
  // a click shows "Refreshing…" and then the new numbers in place, as menu bar apps such as CodexBar do. ⌘R does the
  // same through a hidden item.
  function footerItem(menu, L, refreshTitle) {
    var W = Math.max(280, L ? L.width : 280), H = 24;
    var v = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    v.autoresizingMask = $.NSViewWidthSizable;
    var clock = symbol('clock');
    if (clock) {
      var iv = $.NSImageView.imageViewWithImage(clock);
      iv.frame = $.NSMakeRect(HEAD_X, (H - 14) / 2, 14, 14);
      iv.contentTintColor = $.NSColor.secondaryLabelColor;
      v.addSubview(iv);
    }
    footer = $.NSTextField.labelWithString(footerText());
    footer.font = $.NSFont.menuFontOfSize(0);
    footer.textColor = $.NSColor.secondaryLabelColor;
    footer.frame = $.NSMakeRect(HEAD_TEXT_X, (H - 17) / 2, W - HEAD_TEXT_X - 44, 17);
    v.addSubview(footer);
    if (refreshTitle) {
      var b = $.NSButton.alloc.initWithFrame($.NSMakeRect(W - 38, (H - 22) / 2, 26, 22));
      b.autoresizingMask = $.NSViewMinXMargin;
      b.bezelStyle = $.NSBezelStyleRecessed;
      b.showsBorderOnlyWhileMouseInside = true;
      b.image = symbol('arrow.clockwise');
      b.imagePosition = $.NSImageOnly;
      b.toolTip = refreshTitle + ' (⌘R)';
      b.target = target;
      b.action = 'refresh:';
      v.addSubview(b);
      var key = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(refreshTitle, 'refresh:', 'r');
      key.target = target;
      key.hidden = true;
      key.allowsKeyEquivalentWhenHidden = true;
      menu.addItem(key);
    }
    var mi = $.NSMenuItem.alloc.init;
    mi.view = v;
    menu.addItem(mi);
  }
  // One menu for the item's life: a rebuild swaps its items, so an open menu shows new numbers in place.
  var menu = $.NSMenu.alloc.init;
  menu.autoenablesItems = false;
  function build() {
    drawTitle();
    menu.removeAllItems;
    refs = [];
    if (snap) {
      var L = layout(snap.sections);
      if (snap.card) {
        card(menu, snap.card, L);
        menu.addItem($.NSMenuItem.separatorItem);
      }
      if (!snap.sections.length) {
        add(menu, snap.labels.empty, null);
        withImage(add(menu, snap.labels.addAccount, 'openPanel:'), 'plus');
      }
      snap.sections.forEach(function (s, i) {
        if (i) menu.addItem($.NSMenuItem.separatorItem);
        sectionHeader(menu, s, L);
        s.rows.forEach(function (r) { accountItem(menu, r, L); });
        if (s.more) {
          var sub = $.NSMenu.alloc.init;
          sub.autoenablesItems = false;
          s.more.rows.forEach(function (r) { accountItem(sub, r, L); });
          var mi = add(menu, s.more.title, null);
          mi.image = GUTTER;
          mi.attributedTitle = str(s.more.title, attrs($.NSColor.labelColor, L.font, null));
          mi.enabled = true;
          mi.submenu = sub;
        }
      });
      menu.addItem($.NSMenuItem.separatorItem);
      footerItem(menu, L, snap.labels.refresh);
      withImage(add(menu, snap.labels.openPanel, 'openPanel:', 0, 'o'), 'macwindow');
      menu.addItem($.NSMenuItem.separatorItem);
      if (hotkeyStatus === 'taken' && hotkeyWant)
        withImage(add(menu, snap.labels.hotkeyTaken.replace('{key}', hotkeyWant.label), 'openPanel:'), 'keyboard');
      withImage(add(menu, snap.labels.hide, 'hide:'), 'eye.slash');
    } else {
      footerItem(menu, null, null);
      withImage(add(menu, OPEN_PANEL, 'openPanel:', 0, 'o'), 'macwindow');
    }
    closeItem(menu);
    menu.delegate = target;
    item.menu = menu;
    appearance = ObjC.unwrap(app.effectiveAppearance.name);
  }

  ObjC.registerSubclass({
    name: 'SidebyMenuBar',
    protocols: ['NSMenuDelegate'],
    methods: {
      'menuWillOpen:': { types: ['void', ['id']], implementation: function () { menuOpen = true; try { unregisterHotkey(); } catch (e) {} } },
      'menuDidClose:': {
        types: ['void', ['id']],
        implementation: function () { menuOpen = false; closedAt = uptime(); lastUse = now(); try { registerHotkey(); } catch (e) {} },
      },
      'closeMenu:': { types: ['void', ['id']], implementation: function () {} },
      'tick:': {
        types: ['void', ['id']],
        implementation: function () {
          actions = actions.filter(function (t) { return t.running; });
          // After RESTART_HOURS, while nothing is open, running or just used, it ends with a failure code so launchd
          // starts it again at once (it restarts only after a failed exit): the icon is gone for about a second.
          if (now() - started > ${RESTART_HOURS} * 3600 && !menuOpen && !task && !actions.length && now() - lastUse > 60) $.exit(75);
          if (task && task.running && now() - lastStart > TIMEOUT) task.terminate;
          if (task && !task.running) finishSnapshot();
          lookAtIcon();
          // A shortcut that just registered or failed, and an icon that just showed or went, are told at once.
          if (!task && (forceNext || now() - lastStart >= SNAPSHOT || hotkeyReport() !== hotkeyReported || iconStable !== iconReported)) startSnapshot();
          // The bars are pictures in the colours of the moment; redraw them when light or dark mode changes.
          if (ObjC.unwrap(app.effectiveAppearance.name) !== appearance) build();
          else drawTitle();
          if (footer) footer.stringValue = footerText();
        },
      },
      'peek:': { types: ['void', ['id']], implementation: function () { try { peek(); } catch (e) {} } },
      'refresh:': {
        types: ['void', ['id']],
        implementation: function () {
          // A manual refresh must query the Host, even if an automatic cache read is already running.
          manual = true;
          startSnapshot(true);
          if (footer) footer.stringValue = footerText();
        },
      },
      // A setting changed (the shortcut): read the snapshot again now, after one that is running, with no restart.
      'reload:': {
        types: ['void', ['id']],
        implementation: function () {
          if (!task) { lastStart = 0; startSnapshot(); } else lastStart = 0;
        },
      },
      'openPanel:': { types: ['void', ['id']], implementation: function () { act(['ui', '--background']); } },
      'hide:': {
        types: ['void', ['id']],
        implementation: function () {
          // Hiding also stops it starting at login, so it asks first and says how to bring it back.
          var l = snap ? snap.labels : null;
          if (l && l.hideTitle) {
            var alert = $.NSAlert.alloc.init;
            alert.messageText = l.hideTitle;
            alert.informativeText = l.hideBody;
            alert.addButtonWithTitle(l.hideYes);
            alert.addButtonWithTitle(l.cancel);
            pauseKeys();
            app.activateIgnoringOtherApps(true);
            var answer = alert.runModal;
            app.deactivate;
            resumeKeys();
            // The bridge gives enum constants as strings ("1000") and runModal a number: compare as numbers.
            if (Number(answer) !== Number($.NSAlertFirstButtonReturn)) return;
          }
          act(['menubar', 'off', '--yes']);
        },
      },
      'start:': {
        types: ['void', ['id']],
        implementation: function (sender) {
          var ref = refs[sender.tag - 1];
          if (ref) act(['menubar', 'start', ref]);
        },
      },
    },
  });
  var target = $.SidebyMenuBar.alloc.init;
  // Settings changed elsewhere (the Panel, sideby menubar hotkey) arrive as a distributed notification.
  $.NSDistributedNotificationCenter.defaultCenter.addObserverSelectorNameObject(target, 'reload:', $('${MENUBAR_RELOAD}'), $());
  build();
  startSnapshot();
  // Common modes: the tick also runs while the menu is open, so a refresh started there lands in place.
  $.NSRunLoop.mainRunLoop.addTimerForMode($.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(TICK, target, 'tick:', $(), true), $.NSRunLoopCommonModes);
  $.NSRunLoop.mainRunLoop.addTimerForMode($.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(PEEK, target, 'peek:', $(), true), $.NSRunLoopCommonModes);
  app.run;
}
`
