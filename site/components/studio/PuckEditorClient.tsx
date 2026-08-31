"use client";

import { Puck } from "@puckeditor/core";
import { useCallback, useMemo } from "react";
import { createStudioPuckConfig, type StudioPuckData } from "@/adapters/puck";
import type { DataSourceDefinition, LocalDataRuntime, QueryExecutionRecord } from "@/core/models";
import { puckPermissionsForRole, type StudioRole } from "@/core/permissions";

interface PuckEditorClientProps {
  data: StudioPuckData;
  dataSources: DataSourceDefinition[];
  dataRuntime: LocalDataRuntime;
  role: StudioRole;
  pageId: string;
  queryRevision: string;
  onQueryExecuted: (record: QueryExecutionRecord) => void;
  onChange: (data: StudioPuckData) => void;
  onRequestPreview: (data: StudioPuckData) => void;
}

const puckDnd = { behavior: "auto" } as const;
const puckIframe = { enabled: true, syncHostStyles: true } as const;

export function PuckEditorClient({ data, dataSources, dataRuntime, role, pageId, queryRevision, onQueryExecuted, onChange, onRequestPreview }: PuckEditorClientProps) {
  const config = useMemo(
    () => createStudioPuckConfig(dataSources, dataRuntime, pageId, queryRevision, onQueryExecuted),
    [dataSources, dataRuntime, onQueryExecuted, pageId, queryRevision],
  );
  const permissions = useMemo(() => puckPermissionsForRole(role), [role]);
  const handlePublish = useCallback((nextData: StudioPuckData) => {
    onChange(nextData);
    onRequestPreview(nextData);
  }, [onChange, onRequestPreview]);

  return (
    <div className="puck-editor-shell">
      <Puck
        config={config}
        data={data}
        dnd={puckDnd}
        height="100%"
        iframe={puckIframe}
        permissions={permissions}
        onChange={onChange}
        onPublish={handlePublish}
      />
    </div>
  );
}
