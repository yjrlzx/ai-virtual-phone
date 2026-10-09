"use client";

/** 华为壳自动联动规则调度器：全局常驻组件，按设置页可调的间隔周期检查规则。
 *  无已启用规则或壳未连接时内部直接跳过，不产生任何开销外的副作用。 */

import { useEffect } from "react";
import { checkHuaweiTriggerRules } from "@/lib/huawei-shell/rules";
import { getHuaweiRuleCheckIntervalSec } from "@/lib/huawei-shell/storage";
import { refreshHuaweiWechatSnapshot } from "@/lib/huawei-shell/wechat-snapshot";

const FIRST_CHECK_DELAY_MS = 15_000;

export function HuaweiTriggerRulesScheduler() {
    useEffect(() => {
        let timer: number | undefined;
        let disposed = false;
        const run = () => {
            if (disposed) return;
            // 先刷新微信上下文快照（即使没配联动规则也要跑：这是 char 看到微信内容的入口）
            try {
                refreshHuaweiWechatSnapshot();
            } catch {
                // 单次刷新失败不影响后续周期
            }
            if (disposed) return;
            // checkHuaweiTriggerRules 已为 async（新动作含 LLM/聊天写入），fire-and-forget
            void checkHuaweiTriggerRules().catch(() => {
                // 单次检查失败不影响后续周期
            });
            if (disposed) return;
            if (timer !== undefined) window.clearInterval(timer);
            timer = window.setInterval(run, getHuaweiRuleCheckIntervalSec() * 1000);
        };
        timer = window.setInterval(run, FIRST_CHECK_DELAY_MS);
        return () => {
            disposed = true;
            if (timer !== undefined) window.clearInterval(timer);
        };
    }, []);
    return null;
}
