{{- define "yanimda.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "yanimda.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Bileşen adı: <fullname>-<component> */}}
{{- define "yanimda.component" -}}
{{- printf "%s-%s" (include "yanimda.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "yanimda.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/part-of: yanimda
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
{{ include "yanimda.selectorLabels" . }}
{{- end -}}

{{- define "yanimda.selectorLabels" -}}
app.kubernetes.io/name: {{ include "yanimda.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "yanimda.image" -}}
{{- printf "%s:%s" .repository (toString .tag) -}}
{{- end -}}

{{- define "yanimda.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* Kısıtlı kap güvenlik bağlamı (readOnlyRootFilesystem parametreli) */}}
{{- define "yanimda.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: {{ . }}
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "yanimda.domainHost" -}}
{{- printf "%s.%s" .sub .root.Values.global.domain -}}
{{- end -}}

{{/* İç CA paketi (global.internalCa): yönetilen Postgres/Redis sunucu sertifikası doğrulaması (verify-full, rediss) */}}
{{- define "yanimda.internalCaMount" -}}
{{- if .Values.global.internalCa.configMap }}
- name: internal-ca
  mountPath: /etc/yanimda/tls
  readOnly: true
{{- end }}
{{- end -}}

{{- define "yanimda.internalCaVolume" -}}
{{- if .Values.global.internalCa.configMap }}
- name: internal-ca
  configMap:
    name: {{ .Values.global.internalCa.configMap }}
{{- end }}
{{- end -}}

{{- define "yanimda.internalCaPath" -}}
{{- printf "/etc/yanimda/tls/%s" .Values.global.internalCa.key -}}
{{- end -}}

{{/* OIDC issuer'ları: değer verilmemişse auth.<domain>/realms/<realm> */}}
{{- define "yanimda.issuer" -}}
{{- printf "https://auth.%s/realms/%s" .root.Values.global.domain .realm -}}
{{- end -}}
