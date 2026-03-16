{{ range .testimonials -}}
{{ $text := or .content .icon -}}
{{ $contact := .client.contact -}}
{{ with $text -}}
- {{ . }}{{ with $contact }} — {{ . }}{{ end }}
{{ end -}}
{{ end -}}
