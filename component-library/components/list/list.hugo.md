{{- /* A section page already lists its children in the markdown output, so a list of its
       own section prints nothing here. Any other section prints links, as articles does. */ -}}
{{- $own := false -}}
{{- with .input -}}{{- with .section -}}{{- with site.GetPage . -}}
  {{- $own = eq .RelPermalink page.RelPermalink -}}
{{- end -}}{{- end -}}{{- end -}}
{{- if not $own -}}
  {{- partial "bookshop/components/articles/articles.hugo.md" . -}}
{{- end -}}
