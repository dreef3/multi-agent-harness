{{/*
Expand the name of the chart.
*/}}
{{- define "multi-agent-harness.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "multi-agent-harness.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label: name-version
*/}}
{{- define "multi-agent-harness.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to every resource.
*/}}
{{- define "multi-agent-harness.labels" -}}
helm.sh/chart: {{ include "multi-agent-harness.chart" . }}
{{ include "multi-agent-harness.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels (used in matchLabels and selector).
*/}}
{{- define "multi-agent-harness.selectorLabels" -}}
app.kubernetes.io/name: {{ include "multi-agent-harness.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Backend image reference — resolves registry + prefix + component + tag.
*/}}
{{- define "multi-agent-harness.backendImage" -}}
{{- if .Values.image.registry -}}
{{- printf "%s/%s/backend:%s" .Values.image.registry .Values.image.prefix .Values.image.tag -}}
{{- else -}}
{{- printf "%s/backend:%s" .Values.image.prefix .Values.image.tag -}}
{{- end -}}
{{- end }}

{{/*
Frontend image reference.
*/}}
{{- define "multi-agent-harness.frontendImage" -}}
{{- if .Values.image.registry -}}
{{- printf "%s/%s/frontend:%s" .Values.image.registry .Values.image.prefix .Values.image.tag -}}
{{- else -}}
{{- printf "%s/frontend:%s" .Values.image.prefix .Values.image.tag -}}
{{- end -}}
{{- end }}

{{/*
Sub-agent image reference — agent.image overrides default.
*/}}
{{- define "multi-agent-harness.agentImage" -}}
{{- if .Values.agent.image -}}
{{- .Values.agent.image -}}
{{- else if .Values.image.registry -}}
{{- printf "%s/%s/sub-agent:%s" .Values.image.registry .Values.image.prefix .Values.image.tag -}}
{{- else -}}
{{- printf "%s/sub-agent:%s" .Values.image.prefix .Values.image.tag -}}
{{- end -}}
{{- end }}

{{/*
Name of the Secret holding sensitive credentials.
*/}}
{{- define "multi-agent-harness.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "multi-agent-harness.fullname" . }}-secrets
{{- end -}}
{{- end }}
