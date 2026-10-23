import { ElMessageBox } from "element-plus";
import "./mcpExposure.css";

// A missing new API on an older backend is an ordinary API error, not a gate.
export async function withMcpExposureConfirmation(operation) {
  let confirmations;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await operation(confirmations); }
    catch (error) {
      const challenge = error?.response?.data || error?.mcpChallenge;
      if (challenge?.error !== "mcp_exposure_confirmation_required") throw error;
      try {
        await ElMessageBox.confirm(challenge.confirmationText || "此 MCP 的工具定义超过阈值。每次请求都会固定占用上下文，可以先停用部分工具。", "MCP 上下文占用确认", {
          type: "warning", confirmButtonText: "确认启用", cancelButtonText: "先调整工具",
          closeOnClickModal: false, customClass: "mcp-exposure-confirmation",
        });
      } catch {
        const cancelled = new Error("未确认，MCP 修改未生效");
        cancelled.mcpCancelled = true;
        throw cancelled;
      }
      confirmations = challenge.exposureConfirmations;
    }
  }
  throw new Error("工具定义持续变化，请刷新后重新确认");
}
