"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ui/dialog";

export function useChartExitGuard(onExit: () => void) {
  const [dirty, setDirty] = useState(false), [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  return {
    onDirtyChange: setDirty,
    requestClose: () => { if (dirty) setConfirm(true); else onExit(); },
    confirmation: <ConfirmDialog open={confirm} title="放弃未保存的图表修改？" description="已保存的配置不受影响。选择继续编辑后，可保存当前修改再退出。"
      confirmLabel="放弃修改并退出" cancelLabel="继续编辑" onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); onExit(); }} />,
  };
}
