"use client";

/** 华为壳自动联动规则调度器：全局常驻组件，按设置页可调的间隔周期检查规则。
 *  无已启用规则或壳未连接时内部直接跳过，不产生任何开销外的副作用。 */

import { useEffect } from "react";
import { checkHuaweiTriggerRules } from "@/lib/huawei-shell/rules";
import { getHuaweiRuleCheckIntervalSec } from "@/lib/huawei-shell/storage";

const FIRST_CHECK_DELAY_MS = 15_000;

export function HuaweiTriggerRulesScheduler() {
    useEffect(() => {
        let timer: number | undefined;
        let disposed = false;
        const run = () => {
            if (disposed) return;
            try {
                checkHuaweiTriggerRules();
            } catch {
                // 单次检查失败不影响后续周期
            }
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
