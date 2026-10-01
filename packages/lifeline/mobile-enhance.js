/**
 * Life Line 鎵嬫満绔寮鸿剼鏈?v3
 * 宸︿晶杈规爮瀵艰埅 + 鍏ㄥ睆鍐呭 + 蹇€熸搷浣?
 */
(function () {
  var isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent) || window.innerWidth < 800;
  if (!isMobile) return;

  var css = document.createElement('style');
  css.textContent = `
    * { -webkit-tap-highlight-color: transparent !important; box-sizing: border-box; }
    html, body { margin: 0 !important; padding: 0 !important; overflow-x: hidden !important; }
    body { background: #e8f4fc !important; }
    .mac-titlebar { display: none !important; }
    .mac-window { border-radius: 0 !important; border: none !important; box-shadow: none !important; width: 100vw !important; min-height: 100vh !important; }

    aside.sidebar, .sidebar {
      display: none !important;
      flex-direction: column !important;
      position: fixed !important; top: 0 !important; bottom: 0 !important;
      left: 0 !important; right: auto !important;
      width: 150px !important; height: 100vh !important; height: 100dvh !important;
      max-height: none !important; min-height: 100vh !important; min-height: 100dvh !important;
      z-index: 10001 !important;
      overflow-y: auto !important;
      background: linear-gradient(180deg, #f0f8ff 0%, #e8f4fc 100%) !important;
      border-right: 1px solid #a8d8f0 !important; border-top: none !important;
      padding: calc(50px + env(safe-area-inset-top, 0px)) 0 calc(20px + env(safe-area-inset-bottom, 0px)) !important;
    }
    aside.sidebar.open, .sidebar.open {
      display: block !important;
      flex-direction: column !important;
      box-shadow: 4px 0 30px rgba(100,170,220,0.3) !important;
    }
    aside.sidebar .nav-group, .sidebar .nav-group {
      display: block !important;
      flex-direction: column !important;
      width: 100% !important;
      height: auto !important;
      overflow: visible !important;
    }
    aside.sidebar .nav-group > *, .sidebar .nav-group > * {
      width: 100% !important;
      float: none !important;
    }
    /* 鎶樺彔鍒嗙粍锛氶粯璁ゅ彧鏄剧ず鏍囬锛岀偣鍑诲睍寮€ */
    aside.sidebar .nav-group .nav-item, .sidebar .nav-group .nav-item {
      display: none !important;
    }
    aside.sidebar .nav-group.open .nav-item, .sidebar .nav-group.open .nav-item {
      display: block !important;
    }
    aside.sidebar .nav-group-title, .sidebar .nav-group-title {
      display: block !important;
      cursor: pointer !important;
      position: relative !important;
      padding: 10px 24px 6px !important;
      font-size: 12px !important;
      color: #6a9ac8 !important;
      font-weight: 700 !important;
      width: 100% !important;
    }
    aside.sidebar .nav-group-title::after, .sidebar .nav-group-title::after {
      content: '' !important;
      position: absolute !important;
      right: 20px !important;
      top: 50% !important;
      transform: translateY(-50%) !important;
    }
    aside.sidebar .nav-group.open .nav-group-title::after, .sidebar .nav-group.open .nav-group-title::after {
      content: '' !important;
    }
    .sidebar a, .sidebar button, .sidebar .nav-item, .sidebar [onclick] {
      display: block !important; padding: 10px 24px !important; font-size: 14px !important;
      color: #2a7aa8 !important; text-decoration: none !important; border: none !important;
      background: none !important; width: 100% !important; text-align: left !important; cursor: pointer !important;
      font-weight: 500 !important;
    }
    .sidebar .nav-group-title {
      display: block !important; padding: 10px 24px 6px !important; font-size: 12px !important;
      color: #6a9ac8 !important; font-weight: 700 !important;
    }
    .sidebar a:active, .sidebar button:active { background: rgba(168,216,240,0.3) !important; }

    .nav-menu-btn {
      display: block !important; position: fixed !important; 
      top: calc(12px + env(safe-area-inset-top, 0px)) !important; 
      left: calc(12px + env(safe-area-inset-left, 0px)) !important;
      z-index: 99999 !important; background: rgba(255,255,255,0.95) !important;
      border: 1px solid #a8d8f0 !important; border-radius: 12px !important;
      padding: 10px 18px !important; font-size: 16px !important; color: #2a7aa8 !important;
      box-shadow: 0 2px 10px rgba(100,170,220,0.25) !important;
    }

    .app, .content, .main {
      margin-left: 0 !important; 
      padding-left: calc(12px + env(safe-area-inset-left, 0px)) !important; 
      padding-right: calc(12px + env(safe-area-inset-right, 0px)) !important;
      padding-bottom: calc(80px + env(safe-area-inset-bottom, 0px)) !important; 
      padding-top: calc(60px + env(safe-area-inset-top, 0px)) !important;
      min-height: 100vh !important; min-height: 100dvh !important;
    }

    .ll-sidebar-overlay {
      position: fixed !important; inset: 0 !important; background: rgba(100,160,200,0.4) !important;
      backdrop-filter: blur(2px) !important; z-index: 10000 !important; display: none !important;
    }
    .ll-sidebar-overlay.show { display: block !important; }

    .ll-fab {
      position: fixed !important; 
      bottom: calc(24px + env(safe-area-inset-bottom, 0px)) !important; 
      right: calc(20px + env(safe-area-inset-right, 0px)) !important;
      width: 56px !important; height: 56px !important; border-radius: 50% !important;
      background: linear-gradient(135deg, #5ab8e0, #7ec8e8) !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
      font-size: 28px !important; cursor: pointer !important;
      box-shadow: 0 4px 20px rgba(90,184,224,0.5) !important; border: 3px solid #fff !important; z-index: 9999 !important;
    }
    .ll-fab:active { transform: scale(0.92) !important; }

    .ll-overlay {
      position: fixed !important; inset: 0 !important; background: rgba(100,160,200,0.35) !important;
      backdrop-filter: blur(4px) !important; z-index: 20000 !important; display: none !important;
      align-items: flex-end !important; justify-content: center !important;
    }
    .ll-overlay.show { display: flex !important; }
    .ll-sheet {
      background: #fff !important; border-radius: 24px 24px 0 0 !important;
      width: 100% !important; max-height: 85vh !important; overflow-y: auto !important;
      padding: 20px 20px 30px !important; animation: llSlideUp .3s ease !important;
    }
    @keyframes llSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .ll-sheet-title { font-size: 17px !important; font-weight: 700 !important; text-align: center !important; margin-bottom: 16px !important; color: #2a7aa8 !important; }
    .ll-grid { display: grid !important; grid-template-columns: repeat(2, 1fr) !important; gap: 12px !important; margin-bottom: 12px !important; }
    .ll-action {
      background: linear-gradient(135deg, #e8f4fc, #d0e8f8) !important;
      border: 1px solid rgba(168,216,240,0.4) !important; border-radius: 16px !important;
      padding: 18px 12px !important; text-align: center !important; cursor: pointer !important;
    }
    .ll-action:active { transform: scale(0.96) !important; }
    .ll-action-icon { font-size: 30px !important; margin-bottom: 6px !important; }
    .ll-action-label { font-size: 13px !important; color: #2a7aa8 !important; font-weight: 500 !important; }
    .ll-input, .ll-textarea {
      width: 100% !important; padding: 12px 14px !important; border: 1.5px solid #a8d8f0 !important;
      border-radius: 12px !important; font-size: 15px !important; background: #f0f8fc !important;
      color: #2a5070 !important; outline: none !important; margin-bottom: 10px !important; font-family: inherit !important;
    }
    .ll-textarea { min-height: 100px !important; }
    .ll-btn {
      width: 100% !important; padding: 14px !important; border: none !important; border-radius: 12px !important;
      background: linear-gradient(135deg, #5ab8e0, #7ec8e8) !important;
      color: #fff !important; font-size: 16px !important; font-weight: 600 !important; cursor: pointer !important; margin-top: 6px !important;
    }
    .ll-btn-ghost {
      width: 100% !important; padding: 12px !important; border: 1.5px solid #a8d8f0 !important;
      border-radius: 12px !important; background: transparent !important; color: #3a98c8 !important;
      font-size: 15px !important; cursor: pointer !important; margin-top: 8px !important;
    }
    .ll-toast {
      position: fixed !important; top: 50px !important; left: 50% !important; transform: translateX(-50%) !important;
      background: rgba(42,122,168,0.92) !important; color: #fff !important; padding: 10px 20px !important;
      border-radius: 20px !important; font-size: 14px !important; z-index: 30000 !important;
      opacity: 0 !important; transition: opacity .3s !important; pointer-events: none !important; white-space: nowrap !important;
    }
    .ll-toast.show { opacity: 1 !important; }
    #journalImage { display: none !important; }
    .journal-cam-btn {
      display: flex !important; align-items: center !important; justify-content: center !important;
      gap: 8px !important; padding: 14px !important; border: 2px dashed #a8d8f0 !important;
      border-radius: 12px !important; background: #f0f8fc !important; cursor: pointer !important;
      margin-bottom: 10px !important; font-size: 14px !important; color: #2a7aa8 !important;
    }

    .welcome-card { padding: 16px !important; margin-bottom: 12px !important; text-align: center !important; }
    .welcome-avatar-wrap { width: 64px !important; height: 64px !important; margin: 0 auto 8px !important; }
    .welcome-avatar-wrap .avatar-placeholder { font-size: 28px !important; line-height: 58px !important; }
    .welcome-nickname { font-size: 17px !important; margin-bottom: 4px !important; }
    .welcome-signature { font-size: 12px !important; }

    .countdown-banner {
      padding: 20px 16px !important; border-radius: 18px !important;
      flex-direction: column !important; align-items: flex-start !important;
      gap: 8px !important; margin-bottom: 12px !important;
    }
    .countdown-banner h1 { font-size: 22px !important; margin: 0 0 4px 0 !important; }
    .countdown-banner p { font-size: 13px !important; margin: 0 0 8px 0 !important; opacity: 0.9 !important; }
    .countdown-banner div[style*="text-align:right"] {
      text-align: left !important; width: 100% !important;
      display: flex !important; align-items: baseline !important; gap: 6px !important;
    }
    .countdown-banner div[style*="font-size:44px"] { font-size: 36px !important; line-height: 1 !important; }
    .countdown-banner div[style*="opacity:.85"] { font-size: 13px !important; }

    .card { margin-bottom: 12px !important; border-radius: 16px !important; }
    .card-title { font-size: 15px !important; }
    .grid-2 { grid-template-columns: repeat(2, 1fr) !important; gap: 10px !important; }
    .week-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 8px !important; }
    .week-col { min-height: auto !important; padding: 8px !important; }
    .month-grid { gap: 4px !important; }
    .month-cell { min-height: 60px !important; padding: 4px !important; font-size: 10px !important; }

    .ll-sync-top {
      position: fixed !important; 
      top: calc(12px + env(safe-area-inset-top, 0px)) !important; 
      right: calc(12px + env(safe-area-inset-right, 0px)) !important; 
      z-index: 10000 !important;
      background: rgba(255,255,255,0.95) !important; border: 1px solid #a8d8f0 !important;
      border-radius: 20px !important; padding: 6px 14px !important; font-size: 12px !important;
      display: flex !important; align-items: center !important; gap: 6px !important;
      box-shadow: 0 2px 10px rgba(100,170,220,0.25) !important; color: #2a7aa8 !important;
    }
    .ll-sync-dot { width: 8px !important; height: 8px !important; border-radius: 50% !important; background: #f59e0b !important; }
    .ll-sync-dot.online { background: #10b981 !important; }

    .bottom-nav, .ll-bottom-nav { display: none !important; }
    #ll-sync-badge { display: none !important; }
    .grid .btn-line, .grid-2 .btn-line, .grid .card, .grid-2 .card {
      width: 100% !important;
      box-sizing: border-box !important;
    }

    /* 寮哄埗鎵嬫満绔崟鏍忓竷灞€ */
    .grid, .grid-2, .grid-3, .grid-4, .stat-grid, .stat-grid-4, .home-grid {
      display: flex !important;
      flex-direction: column !important;
      gap: 12px !important;
    }
    .grid > div, .grid-2 > div, .card {
      width: 100% !important;
      min-width: 0 !important;
    }
    .stat-grid-4 { display: grid !important; grid-template-columns: repeat(2, 1fr) !important; gap: 10px !important; }
    /* 蹇嵎鍏ュ彛 - 鍘绘帀鏍囬鍜屽ぇ妗嗭紝鍙暀6涓皬鎸夐挳 */
    #home .grid-2 .card:has(.btn-line) {
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      padding: 0 !important;
    }
    #home .grid-2 .card:has(.btn-line) .card-title {
      display: none !important;
    }
    #home .grid-2 .card:has(.btn-line) .btn-line {
      background: rgba(255,255,255,0.8) !important;
      border: 1px solid #a8d8f0 !important;
      border-radius: 12px !important;
      padding: 12px 8px !important;
      font-size: 12px !important;
      text-align: center !important;
      width: 100% !important;
      box-shadow: 0 2px 8px rgba(100,170,220,0.15) !important;
    }
    #finance-clients .stat-card { width: auto !important; }
    .stat-card { width: 100% !important; }
    .week-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 8px !important; }
    .month-grid { grid-template-columns: repeat(7, 1fr) !important; gap: 3px !important; }
    .month-stats, .week-stats { grid-template-columns: repeat(2, 1fr) !important; gap: 8px !important; }
    .book-grid { grid-template-columns: 1fr !important; gap: 10px !important; }
    .mood-pick { grid-template-columns: repeat(auto-fit, minmax(60px, 1fr)) !important; }
    
    
    /* 鏈堣鍥?- 绉诲姩绔紭鍖栵紙鏃ュ巻app鏍峰紡锛?*/
    #schedule-month .month-stats .stat-mini {
      padding: 8px 4px !important;
    }
    #schedule-month .month-stats .stat-mini .lab {
      font-size: 10px !important;
      white-space: nowrap !important;
    }
    #schedule-month .month-stats .stat-mini .num {
      font-size: 18px !important;
    }
    #schedule-month .month-grid {
      gap: 3px !important;
    }
    #schedule-month .month-grid .month-cell {
      min-height: 120px !important;
      padding: 4px 4px !important;
      font-size: 10px !important;
      border-radius: 8px !important;
      border-width: 1px !important;
      display: flex !important;
      flex-direction: column !important;
      align-items: stretch !important;
    }
    #schedule-month .month-grid .month-cell .md {
      font-size: 11px !important;
      font-weight: 600 !important;
      margin-bottom: 4px !important;
      line-height: 1.2 !important;
      text-align: left !important;
      width: 100% !important;
    }
    #schedule-month .month-grid .month-cell .mt {
      font-size: 9px !important;
      line-height: 1.3 !important;
      padding: 2px 4px !important;
      margin-bottom: 2px !important;
      white-space: normal !important;
      overflow: visible !important;
      text-overflow: clip !important;
      word-break: break-word !important;
      border-radius: 3px !important;
      display: block !important;
      width: 100% !important;
      box-sizing: border-box !important;
      background: rgba(184, 224, 247, 0.35) !important;
      color: #444 !important;
      border-left: 3px solid #7ec8f0 !important;
    }
    #schedule-month .month-grid .month-cell .mt.task-color-pink {
      background: rgba(248, 180, 208, 0.25) !important;
      border-left-color: #f8b4d0 !important;
    }
    #schedule-month .month-grid .month-cell .mt.task-color-yellow {
      background: rgba(253, 230, 138, 0.25) !important;
      border-left-color: #fde68a !important;
    }
    #schedule-month .month-grid .month-cell .mt.task-color-purple {
      background: rgba(216, 180, 254, 0.25) !important;
      border-left-color: #d8b4fe !important;
    }
    #schedule-month .month-grid .month-cell .mt.task-color-green {
      background: rgba(167, 243, 208, 0.25) !important;
      border-left-color: #a7f3d0 !important;
    }
    #schedule-month .month-grid .month-cell .mt.task-color-orange {
      background: rgba(254, 215, 170, 0.25) !important;
      border-left-color: #fed7aa !important;
    }
    #schedule-month .month-grid .month-cell .mt.done {
      opacity: 0.5 !important;
      text-decoration: line-through !important;
    }
    #schedule-month .month-grid .month-cell .mt.node {
      background: rgba(253, 232, 232, 0.8) !important;
      color: #e74c3c !important;
      border-left-color: #e74c3c !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }
    #schedule-month .month-grid .month-cell .more {
      font-size: 9px !important;
      color: var(--blue) !important;
      margin-top: 2px !important;
    }
    #schedule-month .page-header button {
      padding: 6px 10px !important;
      font-size: 11px !important;
      white-space: nowrap !important;
    }
    
    /* 闅愯棌鏈堣鍥?*/
    #schedule-month {
      display: none !important;
    }
    aside.sidebar .nav-group.open .nav-item[onclick*="schedule-month"],
    .sidebar .nav-group.open .nav-item[onclick*="schedule-month"] {
      display: none !important;
    }
    
    
    /* 瀹㈡埛绠＄悊 - 鍔犳柊鍗曟寜閽悓涓€琛?*/
    #finance-clients .soft-card > div:first-child {
      flex-wrap: nowrap !important;
    }
    #finance-clients .soft-card > div:first-child > div:last-child {
      flex-wrap: nowrap !important;
    }
    #finance-clients .weekday-tabs {
      flex-wrap: nowrap !important;
    }
    #finance-clients .chip {
      padding: 6px 10px !important;
      font-size: 12px !important;
    }
    #finance-clients .btn-save {
      padding: 6px 12px !important;
      font-size: 12px !important;
      white-space: nowrap !important;
    }
    
    /* 蹇嵎鍏ュ彛鎸夐挳 - 缂╁皬閫傞厤灞忓箷 */
    #home .grid.grid-2 .btn-line {
      padding: 10px 6px !important;
      font-size: 12px !important;
      border-radius: 10px !important;
    }
    
    /* 棣栭〉缁熻鍗＄墖 - 2x2甯冨眬 */
    #home .grid.grid-4 {
      display: grid !important;
      grid-template-columns: repeat(2, 1fr) !important;
      gap: 10px !important;
    }
    #home .grid.grid-4 .stat-card {
      width: 100% !important;
      padding: 14px 10px !important;
    }
    #home .grid.grid-4 .stat-number {
      font-size: 20px !important;
    }
    
    /* 闅愯棌鍒犻櫎鎸夐挳 - 绉诲姩绔笉鏄剧ず */
    .day-task .del-btn, .mini-task .mt-x {
      display: none !important;
    }
    
    /* 浠婃棩鎬荤粨鎸夐挳 - 绉诲姩绔缉灏?*/
    #schedule-today .btn-line {
      padding: 4px 10px !important;
      font-size: 11px !important;
    }
    
    /* 鑲犺儍鍋ュ悍椤甸潰 - 绉诲姩绔竷灞€ */
    #health-gut .grid.grid-2 {
      display: grid !important;
      grid-template-columns: repeat(2, 1fr) !important;
      gap: 10px !important;
    }
    #health-gut .soft-card {
      padding: 16px 8px !important;
    }
    #health-gut .soft-card div[style*="font-size:48px"] {
      font-size: 32px !important;
    }
    
    /* 鑿滃搧搴撶鐞嗗脊绐?- 绉诲姩绔竷灞€ */
    #dishModal .modal-box {
      max-width: 100% !important;
      width: 100% !important;
      margin: 0 !important;
      border-radius: 0 !important;
    }
    #dishModal #dishManagerList > div {
      flex-wrap: wrap !important;
      gap: 6px !important;
    }
    #dishModal .dm-name {
      flex: 1 1 100% !important;
      width: 100% !important;
    }
    #dishModal .dm-price {
      width: 70px !important;
      flex: 0 0 auto !important;
    }
    #dishModal .dm-cat {
      flex: 1 1 80px !important;
    }
    #dishModal .btn-line {
      flex: 0 0 auto !important;
    }
    #dishModal .grid.grid-3 {
      grid-template-columns: 1fr !important;
      gap: 8px !important;
    }
    
    /* 瀹㈡埛绠＄悊椤甸潰 - 绉诲姩绔竷灞€ */
    #finance-clients .grid {
      display: grid !important;
      grid-template-columns: repeat(2, 1fr) !important;
      gap: 8px !important;
    }
    #finance-clients .stat-card {
      width: 100% !important;
    }
    #finance-clients .stat-card:nth-child(2n) {
      margin-right: 0 !important;
    }
    
    
    /* 鏈堣鍥?- 绉诲姩绔竷灞€ */
    #schedule-month .month-stats {
      display: grid !important;
      grid-template-columns: repeat(5, 1fr) !important;
      gap: 6px !important;
    }
    #schedule-month .month-stats .stat-mini {
      width: 100% !important;
      padding: 8px 4px !important;
    }
    #schedule-month .month-grid {
      gap: 2px !important;
    }
    #schedule-month .soft-card {
      display: block !important;
      width: 100% !important;
      margin-right: 0 !important;
      margin-bottom: 10px !important;
    }
    #schedule-month .grid.grid-2 {
      display: block !important;
    }
    #schedule-month .page-header {
      flex-direction: column !important;
      align-items: flex-start !important;
      gap: 10px !important;
    }
    
    /* 浠婃棩瀹夋帓 - 3鍒楀竷灞€ */
    #schedule-today .grid.grid-3 {
      display: grid !important;
      grid-template-columns: repeat(3, 1fr) !important;
      gap: 10px !important;
    }
    #schedule-today .grid.grid-3 .stat-mini {
      width: 100% !important;
    }
    /* 涓婂崍/涓嬪崍/鏅氫笂 鍗曞垪 */
    #schedule-today .soft-card {
      display: block !important;
      width: 100% !important;
      margin-right: 0 !important;
      margin-bottom: 10px !important;
    }

    /* 鍐呭鍖哄崟鏍?*/
    .content-inner, .main-content, #home.active {
      display: flex !important;
      flex-direction: column !important;
      gap: 12px !important;
    }
  `;
  document.head.appendChild(css);

  // 闅愯棌鏈堣鍥惧鑸」
  setTimeout(function() {
    document.querySelectorAll('.sidebar .nav-item, aside.sidebar .nav-item').forEach(function(item) {
      if (item.getAttribute('onclick') && item.getAttribute('onclick').indexOf('schedule-month') > -1) {
        item.style.display = 'none';
      }
    });
  }, 500);

  // 鑿滃崟鎸夐挳 + 渚ц竟鏍?
  var menuBtn = document.querySelector('.nav-menu-btn');
  var sidebar = document.querySelector('.sidebar');
  var overlay = document.createElement('div');
  overlay.className = 'll-sidebar-overlay';
  document.body.appendChild(overlay);

  // Move sidebar to body to fix fixed positioning (ancestor transform issue)
  if (sidebar) {
    document.body.appendChild(sidebar);
  }

  if (menuBtn && sidebar) {
    menuBtn.textContent = '☰';
    document.body.appendChild(menuBtn);
    menuBtn.onclick = function (e) {
      e.stopPropagation();
      sidebar.classList.toggle('open');
      overlay.classList.toggle('show');
    };
    overlay.onclick = function () {
      sidebar.classList.remove('open');
      overlay.classList.remove('show');
    };
    sidebar.querySelectorAll('.nav-item').forEach(function (item) {
      item.addEventListener('click', function () {
        sidebar.classList.remove('open');
        overlay.classList.remove('show');
      });
    });
    // Toggle nav groups
    sidebar.querySelectorAll('.nav-group-title').forEach(function (title) {
      title.addEventListener('click', function (e) {
        e.stopPropagation();
        this.parentElement.classList.toggle('open');
      });
    });
  }


  // 蹇嵎鍏ュ彛锛氬幓鎺夋爣棰樺拰澶ф锛屾敼鎴?琛?鍒?
  setTimeout(function () {
    var allTitles = document.querySelectorAll('#home .card-title');
    var quickTitle = null;
    allTitles.forEach(function (t) {
      if (t.textContent.indexOf('蹇嵎鍏ュ彛') >= 0) quickTitle = t;
    });
    if (quickTitle) {
      var card = quickTitle.parentElement;
      quickTitle.style.cssText = 'display: none !important;';
      card.style.cssText = 'background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;';
      var innerGrid = card.querySelector('.grid.grid-2');
      if (innerGrid) {
        innerGrid.style.cssText = 'display: grid !important; grid-template-columns: repeat(3, 1fr) !important; gap: 8px !important;';
      }
      var buttons = card.querySelectorAll('.btn-line');
      buttons.forEach(function (btn) {
        btn.style.cssText = 'background: rgba(255,255,255,0.8) !important; border: 1px solid #a8d8f0 !important; border-radius: 12px !important; padding: 12px 8px !important; font-size: 12px !important; text-align: center !important; width: 100% !important; box-shadow: 0 2px 8px rgba(100,170,220,0.15) !important;';
      });
    }
  }, 500);

  // 同步徽标轮询已移除：sync-inject.js 在当前 float 构建中不存在，ll-sync-badge 永不生成，
  // 原 setInterval 每秒空跑 DOM 查询，纯属耗电，故删除。

  // FAB + 蹇€熸搷浣?- 宸茬鐢?
  // var fab = document.createElement('div');
  // fab.className = 'll-fab';
  // fab.textContent = '鉁忥笍';
  // fab.onclick = llOpenCapture;
  // document.body.appendChild(fab);

  var captureSheet = document.createElement('div');
  captureSheet.className = 'll-overlay';
  captureSheet.innerHTML =
    '<div class="ll-sheet">' +
    '<div class="ll-sheet-title">蹇€熻褰?/div>' +
    '<div class="ll-grid">' +
    '<div class="ll-action" onclick="llOCRError()"><div class="ll-action-icon">📷</div><div class="ll-action-label">拍题录错题</div></div>' +
    '<div class="ll-action" onclick="llOCRKnowledge()"><div class="ll-action-icon">📖</div><div class="ll-action-label">拍知识点</div></div>' +
    '<div class="ll-action" onclick="llOpenJournal()"><div class="ll-action-icon">📝</div><div class="ll-action-label">写日记</div></div>' +
    '</div>' +
    '<button class="ll-btn-ghost" onclick="llCloseOverlay()">鍙栨秷</button></div>';
  document.body.appendChild(captureSheet);

  function llOpenCapture() { captureSheet.classList.add('show'); }
  window.llOpenCapture = llOpenCapture;

  window.llCloseOverlay = function () {
    document.querySelectorAll('.ll-overlay.show').forEach(function (el) { el.classList.remove('show'); });
  };
  window.llOpenJournal = function () { window.llCloseOverlay(); if (typeof switchPage === 'function') switchPage('journal-write'); };

  // OCR
  var Tesseract;
  var ocrMode = 'error';
  var ocrSheet = document.createElement('div');
  ocrSheet.className = 'll-overlay';
  ocrSheet.innerHTML =
    '<div class="ll-sheet">' +
    '<div class="ll-sheet-title" id="llOCRTitle">📷 OCR 识别</div>' +
    '<input type="file" id="llOCRFile" accept="image/*" capture="environment" style="display:none">' +
    '<div id="llOCRInput"><div style="text-align:center;padding:30px 0">' +
    '<div style="font-size:60px;margin-bottom:16px">📷</div>' +
    '<div style="color:#2a7aa8;font-size:15px;margin-bottom:20px">瀵瑰噯棰樼洰鎴栧皬绁ㄦ媿鎽?/div>' +
    '<button class="ll-btn" onclick="llTakePhoto()">📷 拍照识别</button>' +
    '<button class="ll-btn-ghost" onclick="llChoosePhoto()">🖼️ 从相册选择</button>' +
    '</div></div>' +
    '<div id="llOCRResult" style="display:none">' +
    '<textarea class="ll-textarea" id="llOCRText" placeholder="识别结果（可编辑）"></textarea>' +
    '<div id="llOCRExtra"></div>' +
    '<button class="ll-btn" onclick="llConfirmOCR()">纭淇濆瓨</button></div>' +
    '<button class="ll-btn-ghost" onclick="llCloseOverlay()">鍙栨秷</button></div>';
  document.body.appendChild(ocrSheet);

  function openOCR(mode, title) {
    ocrMode = mode;
    document.getElementById('llOCRTitle').textContent = title;
    window.llCloseOverlay();
    ocrSheet.classList.add('show');
    document.getElementById('llOCRInput').style.display = 'block';
    document.getElementById('llOCRResult').style.display = 'none';
  }
  window.llOCRError = function () { openOCR('error', '拍照识别错题'); };
  window.llOCRKnowledge = function () { openOCR('knowledge', '拍照识别知识点'); };

  window.llTakePhoto = function () {
    var fi = document.getElementById('llOCRFile');
    fi.value = '';
    fi.setAttribute('capture', 'environment');
    fi.click();
  };
  window.llChoosePhoto = function () {
    var fi = document.getElementById('llOCRFile');
    fi.value = '';
    fi.removeAttribute('capture');
    fi.click();
  };

  document.getElementById('llOCRFile').addEventListener('change', function (e) {
    var file = e.target.files[0]; if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        var maxW = 1200, scale = Math.min(1, maxW / img.width);
        canvas.width = img.width * scale; canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        runOCR(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  function runOCR(dataUrl) {
    document.getElementById('llOCRInput').style.display = 'none';
    document.getElementById('llOCRResult').style.display = 'block';
    document.getElementById('llOCRText').value = '识别中...';
    document.getElementById('llOCRExtra').innerHTML = '';
    if (!Tesseract) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = function () { doOCR(dataUrl); };
      s.onerror = function () { document.getElementById('llOCRText').value = 'OCR加载失败，请检查网络'; };
      document.head.appendChild(s);
    } else { doOCR(dataUrl); }
  }

  function doOCR(dataUrl) {
    document.getElementById('llOCRText').value = '🎤 正在识别...';
    Tesseract.recognize(dataUrl, 'chi_sim+eng', {
      logger: function (m) {
        if (m.status === 'recognizing text')
          document.getElementById('llOCRText').value = '识别中... ' + Math.round(m.progress * 100) + '%';
      }
    }).then(function (result) {
      document.getElementById('llOCRText').value = result.data.text.trim();
    }).catch(function () { document.getElementById('llOCRText').value = '识别失败，请重试'; });
  }

  window.llConfirmOCR = function () {
    var text = document.getElementById('llOCRText').value.trim();
    if (!text) { alert('请输入内容'); return; }
    if (ocrMode === 'error' && typeof state !== 'undefined') {
      state.errors.push({ id: Date.now().toString(36), title: text.slice(0, 50), content: text, date: new Date().toISOString().slice(0, 10) });
      if (typeof saveDB === 'function') saveDB();
      alert('错题已保存');
    } else if (ocrMode === 'knowledge' && typeof state !== 'undefined') {
      state.knowledge.push({ id: Date.now().toString(36), title: text.slice(0, 50), content: text, date: new Date().toISOString().slice(0, 10) });
      if (typeof saveDB === 'function') saveDB();
      alert('鐭ヨ瘑鐐瑰凡淇濆瓨');
    }
    window.llCloseOverlay();
  };


  // 日记拍照
  function setupJournalCamera() {
    var ji = document.getElementById('journalImage');
    if (!ji) return;
    ji.setAttribute('capture', 'environment');
    ji.setAttribute('accept', 'image/*');
    var p = ji.parentElement;
    if (p && !p.querySelector('.journal-cam-btn')) {
      var btn = document.createElement('div');
      btn.className = 'journal-cam-btn';
      btn.innerHTML = '📷 拍照添加日记图片';
      btn.onclick = function () { ji.value = ''; ji.click(); };
      p.insertBefore(btn, ji);
    }
  }
  setTimeout(setupJournalCamera, 1000);
  var origSP = window.switchPage;
  if (origSP) {
    window.switchPage = function (id) { origSP(id); setTimeout(setupJournalCamera, 500); };
  }
})();
