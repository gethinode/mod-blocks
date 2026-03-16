{{ with .links -}}
{{ i18n "llm-links" }}:{{ range . }} [{{ .title }}]({{ .url }}){{ end }}
{{ end -}}
