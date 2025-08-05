{{/*
Expand the name of the chart.
*/}}
{{- define "peerbot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "peerbot.fullname" -}}
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
{{- define "peerbot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "peerbot.labels" -}}
helm.sh/chart: {{ include "peerbot.chart" . }}
{{ include "peerbot.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "peerbot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "peerbot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "peerbot.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "peerbot.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Common environment variables for workers
*/}}
{{- define "peerbot.workerEnv" -}}
- name: SLACK_BOT_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "peerbot.fullname" . }}-secrets
      key: slack-bot-token
- name: GITHUB_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "peerbot.fullname" . }}-secrets
      key: github-token
- name: GOOGLE_CLOUD_PROJECT
  valueFrom:
    configMapKeyRef:
      name: {{ include "peerbot.fullname" . }}-config
      key: gcs-project-id
      optional: true
- name: GOOGLE_APPLICATION_CREDENTIALS
  value: "/etc/gcs/key.json"
{{- end }}

{{/*
Common volume mounts for workers
*/}}
{{- define "peerbot.workerVolumeMounts" -}}
- name: workspace
  mountPath: /workspace
- name: gcs-key
  mountPath: /etc/gcs
  readOnly: true
{{- end }}

{{/*
Common volumes for workers
*/}}
{{- define "peerbot.workerVolumes" -}}
- name: workspace
  emptyDir:
    sizeLimit: {{ .Values.worker.workspace.sizeLimit }}
- name: gcs-key
  secret:
    secretName: {{ include "peerbot.fullname" . }}-secrets
    items:
      - key: gcs-service-account
        path: key.json
    optional: true
{{- end }}