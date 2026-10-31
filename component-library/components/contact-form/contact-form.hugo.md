{{- /* A form cannot be submitted from markdown, so the block prints only what its hook's
       markdown twin chooses to describe: hooks/form.html reads hooks/form.md, when present. */ -}}
{{- with .hook -}}
  {{- $md := printf "%s.md" (strings.TrimSuffix (path.Ext .) .) -}}
  {{- if templates.Exists (printf "_partials/%s" $md) -}}
    {{- partial $md (dict "action" $.action "form-id" $.form_id "page" page) -}}
  {{- end -}}
{{- end -}}
