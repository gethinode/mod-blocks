{{ range .elements -}}
- **{{ with .link }}[{{ end }}{{ .title }}{{ with .link }}]({{ . }}){{ end }}**: {{ or .content .description }}
{{ end -}}
{{ with .links -}}
{{ i18n "llm-links" }}:{{ range . }} [{{ .title }}]({{ .url }}){{ end }}
{{ end -}}
