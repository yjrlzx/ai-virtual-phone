/**
 * Life Line 帮助面板注入脚本
 * 纯 ES5，只注入自己创建的 DOM，不触碰 lifeline 已有元素与 localStorage。
 * 视觉沿用主应用 Y2K 冰蓝千禧风格（--page-bg:#F0F8FF 等同色系）。
 * 暴露 window.__llHelp = { open: fn, close: fn } 供外部调用。
 */
(function () {
  'use strict';

  /* ---------- 样式（与主应用同色系） ---------- */
  var cssText = [
    '.llhelp-mask{position:fixed;inset:0;top:0;left:0;width:100%;height:100%;',
    'background:rgba(240,248,255,0.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);',
    'z-index:9997;display:none;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;}',
    '.llhelp-mask.llhelp-show{display:flex;}',
    '.llhelp-panel{background:rgba(255,255,255,0.92);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);',
    'border:1px solid rgba(255,255,255,0.6);border-radius:24px;',
    'box-shadow:0 20px 60px rgba(130,170,220,0.30);',
    'width:100%;max-width:600px;max-height:82vh;display:flex;flex-direction:column;overflow:hidden;',
    'font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#44546A;}',
    '.llhelp-head{display:flex;align-items:center;justify-content:space-between;',
    'padding:16px 22px;border-bottom:1px solid rgba(184,224,247,0.4);',
    'background:linear-gradient(to bottom,#f8fbff,#eaf4fd);flex:0 0 auto;}',
    '.llhelp-title{font-size:15px;font-weight:600;color:#44546A;letter-spacing:0.5px;}',
    '.llhelp-close{width:28px;height:28px;border-radius:50%;border:none;cursor:pointer;',
    'background:rgba(214,237,249,0.9);color:#44546A;font-size:15px;line-height:1;',
    'display:flex;align-items:center;justify-content:center;}',
    '.llhelp-close:hover{background:#B8E0F7;}',
    '.llhelp-body{padding:18px 22px 26px;overflow-y:auto;flex:1 1 auto;}',
    '.llhelp-body h3{font-size:14px;font-weight:600;color:#44546A;margin:20px 0 10px;',
    'padding:8px 14px;background:#D6EDF9;border-radius:14px;border-left:4px solid #B8E0F7;}',
    '.llhelp-body h3:first-child{margin-top:0;}',
    '.llhelp-body p{font-size:13px;line-height:1.7;color:#44546A;margin:8px 0;}',
    '.llhelp-body .llhelp-sub{color:#8899AA;font-size:12px;}',
    '.llhelp-body ol,.llhelp-body ul{margin:8px 0;padding-left:22px;}',
    '.llhelp-body li{font-size:13px;line-height:1.7;margin:4px 0;color:#44546A;}',
    '.llhelp-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px;',
    'margin:8px 0;border-radius:16px;overflow:hidden;border:1px solid rgba(184,224,247,0.4);}',
    '.llhelp-table th{background:#B8E0F7;color:#44546A;font-weight:600;padding:8px 10px;text-align:left;}',
    '.llhelp-table td{padding:7px 10px;border-top:1px solid rgba(184,224,247,0.35);color:#44546A;background:rgba(255,255,255,0.7);}',
    '.llhelp-table tr:nth-child(even) td{background:rgba(214,237,249,0.35);}',
    '.llhelp-code{display:block;background:#F0F8FF;border:1px dashed rgba(184,224,247,0.8);',
    'border-radius:14px;padding:12px 14px;font-size:12.5px;line-height:1.8;color:#44546A;',
    'white-space:pre-wrap;word-break:break-all;font-family:Consolas,"Courier New",monospace;margin:8px 0;}',
    '.llhelp-quote{background:rgba(184,224,247,0.25);border-radius:14px;padding:10px 14px;',
    'font-size:13px;line-height:1.7;color:#44546A;margin:8px 0;}',
    '.llhelp-fab{position:fixed;right:18px;bottom:22px;z-index:9998;width:52px;height:52px;border-radius:50%;',
    'border:1px solid rgba(255,255,255,0.7);cursor:pointer;',
    'background:linear-gradient(135deg,#B8E0F7,#a8d8f5);color:#44546A;',
    'font-size:22px;font-weight:600;font-family:Georgia,serif;',
    'box-shadow:0 8px 24px rgba(130,170,220,0.4);display:flex;align-items:center;justify-content:center;}',
    '.llhelp-fab:hover{box-shadow:0 10px 28px rgba(130,170,220,0.55);transform:translateY(-1px);}'
  ].join('');

  /* ---------- 内容 ---------- */
  var htmlContent = ''
    + '<h3>核心原则</h3>'
    + '<ol>'
    + '<li>永远用页面里的表单按钮录入，不要直接改 localStorage。</li>'
    + '<li>录入后必须确认右上角同步圆点变绿、显示已同步。</li>'
    + '<li>刷新页面之前先确认已同步，否则刚录的数据会消失。</li>'
    + '<li>批量改数据前先导出一次备份。</li>'
    + '<li>每次只在一个窗口改，改完等另一窗口确认再动。</li>'
    + '</ol>'

    + '<h3>标准五步流程</h3>'
    + '<p><b>第一步 · 备份：</b>打开数据导出页，点导出全部数据，保存 JSON 文件到桌面考研文件夹。建议每天第一次录入前备份一次。</p>'
    + '<p><b>第二步 · 打开正确页面：</b>按要录的数据类型进入对应页面，不要用首页快捷按钮以外的入口。</p>'
    + '<p><b>第三步 · 用表单录入：</b>只点页面里的添加按钮，弹窗里填完点保存。保存成功后页面会出现新内容。</p>'
    + '<p><b>第四步 · 确认同步：</b>看右上角同步状态。变绿已同步说明数据已推上云端；显示离线或推送失败就等一下，或点同步按钮重试，直到变绿。</p>'
    + '<p><b>第五步 · 刷新验证：</b>按 F5 刷新，确认刚录的内容还在。刷新后还在，说明本地和云端都保存成功。</p>'

    + '<h3>各板块正确入口</h3>'
    + '<table class="llhelp-table">'
    + '<tr><th>数据类型</th><th>进入页面</th><th>点击按钮</th></tr>'
    + '<tr><td>记账</td><td>请打开独立记账应用</td><td>账目按微信/支付宝来源分账</td></tr>'
    + '<tr><td>每日任务</td><td>今日安排</td><td>添加任务</td></tr>'
    + '<tr><td>一周任务</td><td>周视图</td><td>添加任务</td></tr>'
    + '<tr><td>习惯打卡</td><td>习惯打卡</td><td>加习惯</td></tr>'
    + '<tr><td>错题</td><td>错题本</td><td>录入错题</td></tr>'
    + '<tr><td>知识点</td><td>知识本</td><td>添加知识点</td></tr>'
    + '<tr><td>日记</td><td>写日记</td><td>保存</td></tr>'
    + '<tr><td>饮食</td><td>饮食记录</td><td>添加</td></tr>'
    + '<tr><td>身材</td><td>身材页</td><td>添加记录</td></tr>'
    + '<tr><td>肠胃</td><td>肠胃健康</td><td>添加</td></tr>'
    + '<tr><td>经期</td><td>经期页</td><td>添加</td></tr>'
    + '<tr><td>重要节点</td><td>里程碑页</td><td>添加节点</td></tr>'
    + '</table>'

    + '<h3>各科进度更新说明</h3>'
    + '<p>各科进度页的百分比和页码是代码静态写死的，页面里没有编辑按钮。更新进度只能改代码，由写代码的窗口处理，秘书窗口不直接改页面。</p>'
    + '<p class="llhelp-sub">秘书窗口汇报进度时统一用下面格式，写代码窗口照抄即可：</p>'
    + '<span class="llhelp-code">数学 周洋鑫 基础篇 105/298页 定积分计算1结束\n数学 800题 70/100\n逻辑 老吕 要点7讲 35/449页\n金融学 黄达 282/516页\n英语 2010年4篇精翻完成\n政治 肖一千 68/1000题</span>'

    + '<h3>给秘书窗口的话术模板</h3>'
    + '<p>每次让秘书录入，直接发下面这段话，不要自由发挥：</p>'
    + '<div class="llhelp-quote">请把下面数据加到 Life Line 网页，用页面表单入口，不要改 localStorage，加完确认右上角已同步，然后回复我每条数据的添加结果。</div>'
    + '<p class="llhelp-sub">任务类：</p>'
    + '<span class="llhelp-code">日期 2026-09-26\n上午 背单词200个 英语 30分钟\n下午 2013年阅读Text1 英语 60分钟\n晚上 逻辑第2讲 逻辑 90分钟</span>'
    + '<p class="llhelp-sub">账目类：</p>'
    + '<span class="llhelp-code">支出 28.8 微信 餐饮 晚餐汉堡\n收入 100 微信 转账 沈老师</span>'

    + '<h3>禁止操作清单</h3>'
    + '<ol>'
    + '<li>禁止在浏览器控制台直接改 localStorage。</li>'
    + '<li>禁止不清空同步状态就刷新。</li>'
    + '<li>禁止两个窗口同时改同一个文件。</li>'
    + '<li>禁止跳过备份直接清空或导入数据。</li>'
    + '<li>禁止把旧数据文件覆盖新文件。</li>'
    + '</ol>'

    + '<h3>常见错误与处理</h3>'
    + '<table class="llhelp-table">'
    + '<tr><th>现象</th><th>原因</th><th>处理</th></tr>'
    + '<tr><td>刷新后数据没了</td><td>录入后没等同步变绿</td><td>重新录入并等已同步</td></tr>'
    + '<tr><td>页面显示0</td><td>同步把旧数据拉下来了</td><td>先导出备份，再重新录入</td></tr>'
    + '<tr><td>同步一直转圈</td><td>网络不通</td><td>检查网络，点同步按钮重试</td></tr>'
    + '<tr><td>手机和电脑数据打架</td><td>双向同步冲突</td><td>电脑改完确认已同步，手机只查看</td></tr>'
    + '</table>';

  /* ---------- DOM 构建 ---------- */
  var inited = false;
  var maskEl = null;
  var fabEl = null;

  function injectCSS() {
    if (document.getElementById('llhelp-style')) return;
    var style = document.createElement('style');
    style.id = 'llhelp-style';
    style.type = 'text/css';
    if (style.styleSheet) {
      style.styleSheet.cssText = cssText; // IE
    } else {
      style.appendChild(document.createTextNode(cssText));
    }
    (document.head || document.getElementsByTagName('head')[0]).appendChild(style);
  }

  function buildFab() {
    fabEl = document.createElement('button');
    fabEl.className = 'llhelp-fab';
    fabEl.type = 'button';
    fabEl.setAttribute('aria-label', '使用帮助');
    fabEl.title = '使用帮助';
    fabEl.appendChild(document.createTextNode('?'));
    fabEl.onclick = function () { openPanel(); };
    document.body.appendChild(fabEl);
  }

  function buildPanel() {
    maskEl = document.createElement('div');
    maskEl.className = 'llhelp-mask';

    var panel = document.createElement('div');
    panel.className = 'llhelp-panel';

    var head = document.createElement('div');
    head.className = 'llhelp-head';

    var title = document.createElement('div');
    title.className = 'llhelp-title';
    title.appendChild(document.createTextNode('Life Line 使用帮助 · 数据录入工作流'));

    var closeBtn = document.createElement('button');
    closeBtn.className = 'llhelp-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.appendChild(document.createTextNode('×'));
    closeBtn.onclick = function () { closePanel(); };

    head.appendChild(title);
    head.appendChild(closeBtn);

    var body = document.createElement('div');
    body.className = 'llhelp-body';
    body.innerHTML = htmlContent;

    panel.appendChild(head);
    panel.appendChild(body);
    maskEl.appendChild(panel);

    // 点遮罩空白处关闭
    maskEl.onclick = function (e) {
      if (e.target === maskEl) closePanel();
    };

    document.body.appendChild(maskEl);
  }

  function openPanel() {
    ensureInit();
    if (maskEl) maskEl.className = 'llhelp-mask llhelp-show';
  }

  function closePanel() {
    if (maskEl) maskEl.className = 'llhelp-mask';
  }

  function ensureInit() {
    if (inited) return;
    if (!document.body) return;
    inited = true;
    injectCSS();
    buildFab();
    buildPanel();
  }

  function init() {
    ensureInit();
  }

  // 挂载时机兜底
  if (document.readyState === 'loading') {
    if (document.addEventListener) {
      document.addEventListener('DOMContentLoaded', init, false);
    } else if (document.attachEvent) {
      document.attachEvent('onreadystatechange', function () {
        if (document.readyState === 'complete') init();
      });
    }
  } else {
    init();
  }

  // 暴露外部调用入口
  window.__llHelp = {
    open: function () { openPanel(); },
    close: function () { closePanel(); }
  };
})();
