{{/*
Expand the name of the chart.
*/}}
{{- define "lobu.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "lobu.fullname" -}}
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
Create chart name and version as used by the chart label.
*/}}
{{- define "lobu.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "lobu.labels" -}}
helm.sh/chart: {{ include "lobu.chart" . }}
{{ include "lobu.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "lobu.selectorLabels" -}}
app.kubernetes.io/name: {{ include "lobu.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
App selector labels
*/}}
{{- define "lobu.appSelectorLabels" -}}
{{ include "lobu.selectorLabels" . }}
app.kubernetes.io/component: api
{{- end }}

{{/*
Worker selector labels
*/}}
{{- define "lobu.workerSelectorLabels" -}}
{{ include "lobu.selectorLabels" . }}
app.kubernetes.io/component: worker
{{- end }}

{{/*
Embeddings selector labels
*/}}
{{- define "lobu.embeddingsSelectorLabels" -}}
{{ include "lobu.selectorLabels" . }}
app.kubernetes.io/component: embeddings
{{- end }}

{{/*
Create the app image name
*/}}
{{- define "lobu.appImage" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion }}
{{- printf "%s/%s-app:%s" .Values.image.registry .Values.image.repository $tag }}
{{- end }}

{{/*
Create the worker image name
*/}}
{{- define "lobu.workerImage" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion }}
{{- printf "%s/%s-worker:%s" .Values.image.registry .Values.image.repository $tag }}
{{- end }}

{{/*
Create the embeddings service image name
*/}}
{{- define "lobu.embeddingsImage" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion }}
{{- printf "%s/%s-embeddings:%s" .Values.image.registry .Values.image.repository $tag }}
{{- end }}
