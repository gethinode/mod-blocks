{{- $pages := slice -}}
{{- $sort := or .input.sort "date" -}}
{{- $reverse := .input.reverse -}}
{{- $nested := .input.nested -}}
{{- with .input -}}
  {{- $sec := "" -}}
  {{- with .section -}}{{- $sec = site.GetPage . -}}{{- end -}}
  {{- with $sec -}}
    {{- if $nested -}}
      {{- $pages = .RegularPagesRecursive -}}
    {{- else -}}
      {{- $pages = .RegularPages -}}
    {{- end -}}
    {{- if eq $sort "date" -}}{{- $pages = $pages.ByDate -}}{{- end -}}
    {{- if eq $sort "title" -}}{{- $pages = $pages.ByTitle -}}{{- end -}}
    {{- if eq $sort "weight" -}}{{- $pages = $pages.ByWeight -}}{{- end -}}
    {{- if $reverse -}}{{- $pages = $pages.Reverse -}}{{- end -}}
  {{- end -}}
{{- end -}}
{{- with .limit -}}{{- $pages = first . $pages -}}{{- end -}}
{{ range $pages -}}
- [{{ .Title }}]({{ .RelPermalink }})
{{ end -}}
{{ with .more }}{{ with .link -}}
[{{ or $.more.title (i18n "llm-links") }}]({{ . }})
{{ end }}{{ end -}}
