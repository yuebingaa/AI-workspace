"use client";

import { Puck } from "@puckeditor/core";
import { useMemo } from "react";
import { createStudioPuckConfig, type StudioPuckData } from "@/adapters/puck";
import type { DataSourceDefinition, LocalDataRuntime } from "@/core/models";
import { puckPermissionsForRole, type StudioRole } from "@/core/permissions";

interface PuckEditorClientProps {
  data: StudioPuckData;
  dataSources: DataSourceDefinition[];
  dataRuntime: LocalDataRuntime;
  role: StudioRole;
  onChange: (data: StudioPuckData) => void;
  onRequestPreview: (data: StudioPuckData) => void;
}

export function PuckEditorClient({ data, dataSources, dataRuntime, role, onChange, onRequestPreview }: PuckEditorClientProps) {
  const config = useMemo(() => createStudioPuckConfig(dataSources, dataRuntime), [dataSources, dataRuntime]);
  return (
    <div className="puck-editor-shell">
      <Puck
        config={config}
        data={data}
        dnd={{ behavior: "auto" }}
        height="100%"
        iframe={{ enabled: true, syncHostStyles: true }}
        permissions={puckPermissionsForRole(role)}
        onChange={onChange}
        onPublish={(nextData) => {
          onChange(nextData);
          onRequestPreview(nextData);
        }}
      />
    </div>
  );
}
