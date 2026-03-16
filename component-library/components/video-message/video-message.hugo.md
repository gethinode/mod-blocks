{{ with .video }}{{ with .provider }}Video from {{ . }}.
{{ end }}{{ end -}}
{{ range .messages -}}
- **{{ .title }}**: {{ .content }}
{{ end -}}
