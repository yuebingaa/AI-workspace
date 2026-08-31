"use client";

import { Puck } from "@puckeditor/core";
import { studioPuckConfig, type StudioPuckData } from "@/adapters/puck";

interface PuckEditorClientProps {
  data: StudioPuckData;
  onChange: (data: StudioPuckData) => void;
  onRequestPreview: (data: StudioPuckData) => void;
}

export function PuckEditorClient({ data, onChange, onRequestPreview }: PuckEditorClientProps) {
  return (
    <div className="puck-editor-shell">
      <Puck
        config={studioPuckConfig}
        data={data}
        dnd={{ behavior: "auto" }}
        height="100%"
        iframe={{ enabled: true, syncHostStyles: true }}
        onChange={onChange}
        onPublish={(nextData) => {
          onChange(nextData);
          onRequestPreview(nextData);
        }}
      />
    </div>
  );
}
