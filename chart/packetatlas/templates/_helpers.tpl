{{- define "packetatlas.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "packetatlas.fullname" -}}
{{- if contains .Chart.Name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "packetatlas.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "packetatlas.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: {{ .Values.mode }}
{{- end }}

{{- define "packetatlas.selectorLabels" -}}
app.kubernetes.io/name: {{ include "packetatlas.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "packetatlas.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "packetatlas.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "packetatlas.tokenSecret" -}}
{{- default (printf "%s-token" (include "packetatlas.fullname" .)) .Values.agent.existingSecret }}
{{- end }}

{{/* Fail early on settings the binary would reject at startup. */}}
{{- define "packetatlas.validate" -}}
{{- if not (has .Values.mode (list "agent" "server")) }}
{{- fail (printf "mode must be agent or server, got %q" .Values.mode) }}
{{- end }}
{{- if eq .Values.mode "agent" }}
{{- if not .Values.agent.hub }}{{ fail "agent.hub is required in agent mode" }}{{ end }}
{{- if not .Values.agent.cluster }}{{ fail "agent.cluster is required in agent mode" }}{{ end }}
{{- if and (not .Values.agent.token) (not .Values.agent.existingSecret) }}
{{- fail "agent mode needs agent.token or agent.existingSecret" }}
{{- end }}
{{- end }}
{{- end }}
