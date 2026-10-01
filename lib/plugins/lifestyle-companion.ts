// 内置插件：生活伴侣 - 情绪日记/喝水/经期/纸条/焦虑趋势
export const LIFESTYLE_COMPANION_PLUGIN_SOURCE = `
const TAGS = ["开心","平静","烦躁","难过","焦虑","累","委屈","想他","饿","困","生气","想家","迷茫","充实","轻松","紧张","害羞","得意","emo","还好"];

async function kvGet(k) { try { const r = await fetch("/api/kv?key="+encodeURIComponent(k)); return r.ok ? await r.text() : null; } catch { return null; } }
async function kvSet(k, v) { try { await fetch("/api/kv", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({key:k, value:v}) }); } catch {} }

export default {
  manifest: {
    id: "lifestyle-companion",
    name: "生活伴侣",
    apiVersion: 1,
    version: "1.0.1",
    description: "情绪日记、喝水、经期、焦虑趋势",
    permissions: ["storage", "ui", "network"],
  },
  setup(ctx) {
    const today = () => new Date().toISOString().slice(0,10);
    ctx.ui.slot("settings.section", (host) => {
      async function render() {
        const w = parseInt((await kvGet("water_count_"+today())) || "0");
        const tagsRaw = await kvGet("mood_diary_"+today());
        const tags = tagsRaw ? JSON.parse(tagsRaw).tags : [];
        const period = await kvGet("period_last_date") || "未设置";
        host.innerHTML = \`
          <div style="padding:14px;font-family:sans-serif;">
            <b style="font-size:15px;">生活伴侣</b>
            <div style="margin-top:12px;font-size:13px;color:#666;">情绪日记（点选当天心情）</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">
              \${TAGS.map(t => \`<button data-tag="\${t}" style="padding:8px 12px;min-height:44px;border-radius:999;border:1px solid #ccc;background:\${tags.includes(t)?'#ff6b6b22':'transparent'};cursor:pointer;font-size:13px;">\${t}</button>\`).join("")}
            </div>
            <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:13px;">喝水：今天 \${w} 杯</span>
              <button id="lc-water" style="min-height:44px;padding:8px 16px;border:none;border-radius:8px;background:#4ecdc4;color:#fff;cursor:pointer;">+1杯</button>
            </div>
            <div style="margin-top:12px;font-size:13px;color:#666;">经期上次：\${period}</div>
            <input type="date" id="lc-period" style="margin-top:6px;padding:8px;border:1px solid #ccc;border-radius:6px;min-height:44px;">
          </div>\`;
        host.querySelectorAll("[data-tag]").forEach(btn => {
          btn.onclick = async () => {
            const t = btn.dataset.tag;
            const cur = tags.includes(t) ? tags.filter((x: string) => x !== t) : [...tags, t];
            await kvSet("mood_diary_"+today(), JSON.stringify({tags: cur, ts: Date.now()}));
            render();
          };
        });
        host.querySelector("#lc-water")!.onclick = async () => {
          await kvSet("water_count_"+today(), String(w+1));
          render();
        };
        (host.querySelector("#lc-period") as HTMLInputElement).onchange = async (e) => {
          await kvSet("period_last_date", (e.target as HTMLInputElement).value);
          render();
        };
      }
      render();
    });
    return () => {};
  },
};
`;
