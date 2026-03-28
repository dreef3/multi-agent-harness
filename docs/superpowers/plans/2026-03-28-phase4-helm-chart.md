# Helm Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a production-ready Helm chart for deploying multi-agent-harness on Kubernetes, covering backend, frontend, ingress, RBAC, persistence, and optional OpenShift Route support.

**Architecture:** The chart lives at `charts/multi-agent-harness/` and deploys the backend and frontend as separate Deployments with a shared PVC for `/pi-agent` auth tokens. The backend's `ServiceAccount` is granted a namespaced `Role` allowing Job creation and Pod inspection so it can manage sub-agent Jobs at runtime. An optional `Ingress` (or OpenShift `Route`) terminates TLS in front of the frontend. The chart is overlay-friendly: `values-gke.yaml` and `values-openshift.yaml` provide platform-specific overrides.

**Tech Stack:** Helm 3, Kubernetes 1.26+, kubeval (validation), helm lint.

---

## File Map

Files to create:

- `charts/multi-agent-harness/Chart.yaml` — chart metadata
- `charts/multi-agent-harness/values.yaml` — default values
- `charts/multi-agent-harness/values-gke.yaml` — GKE overlay
- `charts/multi-agent-harness/values-openshift.yaml` — OpenShift overlay
- `charts/multi-agent-harness/templates/_helpers.tpl` — named template helpers
- `charts/multi-agent-harness/templates/configmap.yaml` — backend env config
- `charts/multi-agent-harness/templates/secrets.yaml` — sensitive credentials
- `charts/multi-agent-harness/templates/serviceaccount.yaml` — SA creation (extracted from rbac.yaml for clean separation)
- `charts/multi-agent-harness/templates/rbac.yaml` — Role + RoleBinding
- `charts/multi-agent-harness/templates/pvc.yaml` — two PersistentVolumeClaims
- `charts/multi-agent-harness/templates/backend-deployment.yaml` — backend Deployment
- `charts/multi-agent-harness/templates/backend-service.yaml` — backend ClusterIP Service
- `charts/multi-agent-harness/templates/frontend-deployment.yaml` — frontend Deployment
- `charts/multi-agent-harness/templates/frontend-service.yaml` — frontend ClusterIP Service
- `charts/multi-agent-harness/templates/ingress.yaml` — standard Ingress (conditional)
- `charts/multi-agent-harness/templates/route.yaml` — OpenShift Route (conditional)

---

## Task 1 — Create Chart.yaml and values.yaml

**Files:**
- Create: `charts/multi-agent-harness/Chart.yaml`
- Create: `charts/multi-agent-harness/values.yaml`

- [ ] **Step 1: Create the chart directory**

```bash
mkdir -p charts/multi-agent-harness/templates
```

- [ ] **Step 2: Create Chart.yaml**

Create `charts/multi-agent-harness/Chart.yaml`:

```yaml
apiVersion: v2
name: multi-agent-harness
description: AI agent orchestration harness for software development
type: application
version: 0.1.0
appVersion: "0.0.1"
keywords:
  - ai
  - agents
  - automation
maintainers:
  - name: harness-team
```

- [ ] **Step 3: Create values.yaml**

Create `charts/multi-agent-harness/values.yaml`:

```yaml
# Image configuration
image:
  # Corporate registry prefix — empty = use Docker Hub / GHCR
  # Example: corp-artifactory.example.com/docker-local
  registry: ""
  prefix: "ghcr.io/dreef3/multi-agent-harness"
  tag: "latest"
  pullPolicy: IfNotPresent
  pullSecrets: []

# Backend service configuration
backend:
  replicaCount: 1
  resources:
    requests:
      cpu: "250m"
      memory: "512Mi"
    limits:
      cpu: "1000m"
      memory: "1Gi"
  # Extra env vars injected into backend container
  env: {}

# Frontend service configuration
frontend:
  replicaCount: 1
  resources:
    requests:
      cpu: "50m"
      memory: "64Mi"
    limits:
      cpu: "200m"
      memory: "128Mi"

# Ingress (standard Kubernetes)
ingress:
  enabled: true
  className: nginx
  host: harness.example.com
  annotations: {}
  tls: []
  # tls:
  #   - hosts:
  #       - harness.example.com
  #     secretName: harness-tls

# OpenShift Route (alternative to Ingress — enable only on OpenShift)
route:
  enabled: false
  host: ""
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect

# Persistence
persistence:
  # Backend data directory (SQLite, session files)
  data:
    storageClass: ""
    size: 10Gi
    accessMode: ReadWriteOnce
  # Shared pi-agent auth tokens (backend + agent pods must both mount this)
  piAuth:
    storageClass: ""
    size: 1Gi
    accessMode: ReadWriteMany

# Agent pod defaults (used as Job template values by backend at runtime, not a Deployment)
agent:
  # Defaults to image.prefix/sub-agent:image.tag if empty
  image: ""
  resources:
    requests:
      cpu: "500m"
      memory: "2Gi"
    limits:
      cpu: "2000m"
      memory: "4Gi"

# Auth (OIDC)
auth:
  enabled: false
  oidcIssuerUrl: ""
  oidcClientId: ""
  oidcAudience: ""

# Corporate TLS — PEM bundle injected into trust stores
tls:
  customCACert: ""

# Corporate HTTP proxy
proxy:
  httpProxy: ""
  httpsProxy: ""
  noProxy: "localhost,127.0.0.1,.cluster.local,.svc"

# ServiceAccount for backend pod (needs Job + Pod permissions in its namespace)
serviceAccount:
  create: true
  name: harness-agent-runner
  # GKE Workload Identity example:
  # annotations:
  #   iam.gke.io/gcp-service-account: harness@my-project.iam.gserviceaccount.com
  annotations: {}

# Secrets — set via --set, external-secrets operator, or a pre-existing Secret
secrets:
  # Set to name of a pre-existing Secret to use instead of creating one
  existingSecret: ""
  githubToken: ""
  anthropicApiKey: ""
  webhookSecret: ""
```

- [ ] **Step 4: Verify chart directory structure**

```bash
ls charts/multi-agent-harness/
```

Expected output includes `Chart.yaml` and `values.yaml`.

---

## Task 2 — Create _helpers.tpl

**Files:**
- Create: `charts/multi-agent-harness/templates/_helpers.tpl`

- [ ] **Step 1: Create _helpers.tpl with all named templates**

Create `charts/multi-agent-harness/templates/_helpers.tpl`:

```gotemplate
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
```

---

## Task 3 — Create configmap.yaml

**Files:**
- Create: `charts/multi-agent-harness/templates/configmap.yaml`

- [ ] **Step 1: Create configmap.yaml**

Create `charts/multi-agent-harness/templates/configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "multi-agent-harness.fullname" . }}-config
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "multi-agent-harness.labels" . | nindent 4 }}
data:
  AUTH_ENABLED: {{ .Values.auth.enabled | quote }}
  OIDC_ISSUER_URL: {{ .Values.auth.oidcIssuerUrl | quote }}
  OIDC_CLIENT_ID: {{ .Values.auth.oidcClientId | quote }}
  OIDC_AUDIENCE: {{ .Values.auth.oidcAudience | quote }}
  CONTAINER_RUNTIME: "kubernetes"
  K8S_NAMESPACE: {{ .Release.Namespace | quote }}
  SUB_AGENT_IMAGE: {{ include "multi-agent-harness.agentImage" . | quote }}
  PI_AGENT_VOLUME: {{ printf "%s-pi-auth" (include "multi-agent-harness.fullname" .) | quote }}
  HARNESS_API_URL: {{ printf "http://%s-backend:3000" (include "multi-agent-harness.fullname" .) | quote }}
  {{- with .Values.proxy.httpProxy }}
  HTTP_PROXY: {{ . | quote }}
  http_proxy: {{ . | quote }}
  {{- end }}
  {{- with .Values.proxy.httpsProxy }}
  HTTPS_PROXY: {{ . | quote }}
  https_proxy: {{ . | quote }}
  {{- end }}
  {{- with .Values.proxy.noProxy }}
  NO_PROXY: {{ . | quote }}
  no_proxy: {{ . | quote }}
  {{- end }}
  {{- range $key, $val := .Values.backend.env }}
  {{ $key }}: {{ $val | quote }}
  {{- end }}
```

---

## Task 4 — Create secrets.yaml

**Files:**
- Create: `charts/multi-agent-harness/templates/secrets.yaml`

- [ ] **Step 1: Create secrets.yaml**

Create `charts/multi-agent-harness/templates/secrets.yaml`:

```yaml
{{- if not .Values.secrets.existingSecret }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "multi-agent-harness.fullname" . }}-secrets
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "multi-agent-harness.labels" . | nindent 4 }}
type: Opaque
stringData:
  {{- with .Values.secrets.githubToken }}
  GITHUB_TOKEN: {{ . | quote }}
  {{- end }}
  {{- with .Values.secrets.anthropicApiKey }}
  ANTHROPIC_API_KEY: {{ . | quote }}
  {{- end }}
  {{- with .Values.secrets.webhookSecret }}
  WEBHOOK_SECRET: {{ . | quote }}
  {{- end }}
  {{- with .Values.tls.customCACert }}
  CUSTOM_CA_BUNDLE: {{ . | quote }}
  {{- end }}
{{- end }}
```

---

## Task 5 — Create serviceaccount.yaml and rbac.yaml

**Files:**
- Create: `charts/multi-agent-harness/templates/serviceaccount.yaml`
- Create: `charts/multi-agent-harness/templates/rbac.yaml`

- [ ] **Step 1: Create serviceaccount.yaml**

Create `charts/multi-agent-harness/templates/serviceaccount.yaml`:

```yaml
{{- if .Values.serviceAccount.create }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .Values.serviceAccount.name }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "multi-agent-harness.labels" . | nindent 4 }}
  {{- with .Values.serviceAccount.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
```

- [ ] **Step 2: Create rbac.yaml**

Create `charts/multi-agent-harness/templates/rbac.yaml`:

```yaml
{{- if .Values.serviceAccount.create }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {{ include "multi-agent-harness.fullname" . }}-agent-runner
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "multi-agent-harness.labels" . | nindent 4 }}
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "list", "watch", "delete"]
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ include "multi-agent-harness.fullname" . }}-agent-runner
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "multi-agent-harness.labels" . | nindent 4 }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {{ include "multi-agent-harness.fullname" . }}-agent-runner
subjects:
  - kind: ServiceAccount
    name: {{ .Values.serviceAccount.name }}
    namespace: {{ .Release.Namespace }}
{{- end }}
```

---

## Task 6 — Create pvc.yaml

**Files:**
- Create: `charts/multi-agent-harness/templates/pvc.yaml`

- [ ] **Step 1: Create pvc.yaml with both PVCs**

Create `charts/multi-agent-harness/templates/pvc.yaml`:

```yaml
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ include "multi-agent-harness.fullname" . }}-data
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "multi-agent-harness.labels" . | nindent 4 }}
spec:
  accessModes:
    - {{ .Values.persistence.data.accessMode }}
  resources:
    requests:
      storage: {{ .Values.persistence.data.size }}
  {{- with .Values.persistence.data.storageClass }}
  storageClassName: {{ . }}
  {{- end }}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ include "multi-agent-harness.fullname" . }}-pi-auth
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "multi-agent-harness.labels" . | nindent 4 }}
spec:
  accessModes:
    - {{ .Values.persistence.piAuth.accessMode }}
  resources:
    requests:
      storage: {{ .Values.persistence.piAuth.size }}
  {{- with .Values.persistence.piAuth.storageClass }}
  storageClassName: {{ . }}
  {{- end }}
```

---

## Task 7 — Create backend-deployment.yaml and backend-service.yaml

**Files:**
- Create: `charts/multi-agent-harness/templates/backend-deployment.yaml`
- Create: `charts/multi-agent-harness/templates/backend-service.yaml`

- [ ] **Step 1: Create backend-deployment.yaml**

Create `charts/multi-agent-harness/templates/backend-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "multi-agent-harness.fullname" . }}-backend
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "multi-agent-harness.labels" . | nindent 4 }}
    app.kubernetes.io/component: backend
spec:
  replicas: {{ .Values.backend.replicaCount }}
  selector:
    matchLabels:
      {{- include "multi-agent-harness.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: backend
  template:
    metadata:
      labels:
        {{- include "multi-agent-harness.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: backend
    spec:
      {{- with .Values.image.pullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      serviceAccountName: {{ .Values.serviceAccount.name }}
      securityContext:
        runAsNonRoot: true
      containers:
        - name: backend
          image: {{ include "multi-agent-harness.backendImage" . }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 3000
              protocol: TCP
          envFrom:
            - configMapRef:
                name: {{ include "multi-agent-harness.fullname" . }}-config
            - secretRef:
                name: {{ include "multi-agent-harness.secretName" . }}
          livenessProbe:
            httpGet:
              path: /api/health
              port: http
            initialDelaySeconds: 15
            periodSeconds: 30
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /api/health
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3
          resources:
            {{- toYaml .Values.backend.resources | nindent 12 }}
          volumeMounts:
            - name: data
              mountPath: /app/data
            - name: pi-auth
              mountPath: /pi-agent
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: {{ include "multi-agent-harness.fullname" . }}-data
        - name: pi-auth
          persistentVolumeClaim:
            claimName: {{ include "multi-agent-harness.fullname" . }}-pi-auth
```

- [ ] **Step 2: Create backend-service.yaml**

Create `charts/multi-agent-harness/templates/backend-service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ include "multi-agent-harness.fullname" . }}-backend
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "multi-agent-harness.labels" . | nindent 4 }}
    app.kubernetes.io/component: backend
spec:
  type: ClusterIP
  ports:
    - port: 3000
      targetPort: http
      protocol: TCP
      name: http
  selector:
    {{- include "multi-agent-harness.selectorLabels" . | nindent 4 }}
    app.kubernetes.io/component: backend
```

---

## Task 8 — Create frontend-deployment.yaml and frontend-service.yaml

**Files:**
- Create: `charts/multi-agent-harness/templates/frontend-deployment.yaml`
- Create: `charts/multi-agent-harness/templates/frontend-service.yaml`

- [ ] **Step 1: Create frontend-deployment.yaml**

Create `charts/multi-agent-harness/templates/frontend-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "multi-agent-harness.fullname" . }}-frontend
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "multi-agent-harness.labels" . | nindent 4 }}
    app.kubernetes.io/component: frontend
spec:
  replicas: {{ .Values.frontend.replicaCount }}
  selector:
    matchLabels:
      {{- include "multi-agent-harness.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: frontend
  template:
    metadata:
      labels:
        {{- include "multi-agent-harness.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: frontend
    spec:
      {{- with .Values.image.pullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      securityContext:
        runAsNonRoot: true
      containers:
        - name: frontend
          image: {{ include "multi-agent-harness.frontendImage" . }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 80
              protocol: TCP
          env:
            - name: BACKEND_URL
              value: {{ printf "http://%s-backend:3000" (include "multi-agent-harness.fullname" .) | quote }}
          livenessProbe:
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 5
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 3
            periodSeconds: 10
          resources:
            {{- toYaml .Values.frontend.resources | nindent 12 }}
```

- [ ] **Step 2: Create frontend-service.yaml**

Create `charts/multi-agent-harness/templates/frontend-service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ include "multi-agent-harness.fullname" . }}-frontend
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "multi-agent-harness.labels" . | nindent 4 }}
    app.kubernetes.io/component: frontend
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: http
      protocol: TCP
      name: http
  selector:
    {{- include "multi-agent-harness.selectorLabels" . | nindent 4 }}
    app.kubernetes.io/component: frontend
```

---

## Task 9 — Create ingress.yaml and route.yaml

**Files:**
- Create: `charts/multi-agent-harness/templates/ingress.yaml`
- Create: `charts/multi-agent-harness/templates/route.yaml`

- [ ] **Step 1: Create ingress.yaml**

Create `charts/multi-agent-harness/templates/ingress.yaml`:

```yaml
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "multi-agent-harness.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "multi-agent-harness.labels" . | nindent 4 }}
  {{- with .Values.ingress.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- with .Values.ingress.className }}
  ingressClassName: {{ . }}
  {{- end }}
  {{- with .Values.ingress.tls }}
  tls:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  rules:
    - host: {{ .Values.ingress.host }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ include "multi-agent-harness.fullname" . }}-frontend
                port:
                  name: http
{{- end }}
```

- [ ] **Step 2: Create route.yaml (OpenShift)**

Create `charts/multi-agent-harness/templates/route.yaml`:

```yaml
{{- if .Values.route.enabled }}
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: {{ include "multi-agent-harness.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "multi-agent-harness.labels" . | nindent 4 }}
spec:
  {{- with .Values.route.host }}
  host: {{ . }}
  {{- end }}
  to:
    kind: Service
    name: {{ include "multi-agent-harness.fullname" . }}-frontend
  port:
    targetPort: http
  tls:
    termination: {{ .Values.route.tls.termination }}
    insecureEdgeTerminationPolicy: {{ .Values.route.tls.insecureEdgeTerminationPolicy }}
{{- end }}
```

---

## Task 10 — Create platform overlay files

**Files:**
- Create: `charts/multi-agent-harness/values-gke.yaml`
- Create: `charts/multi-agent-harness/values-openshift.yaml`

- [ ] **Step 1: Create values-gke.yaml**

Create `charts/multi-agent-harness/values-gke.yaml`:

```yaml
# GKE-specific overrides
# Usage: helm upgrade --install harness charts/multi-agent-harness -f charts/multi-agent-harness/values-gke.yaml

ingress:
  className: gce
  annotations:
    kubernetes.io/ingress.class: "gce"
    # Uncomment to use a static IP reserved in GCP:
    # kubernetes.io/ingress.global-static-ip-name: "harness-ip"

persistence:
  data:
    # GKE SSD (Compute Engine Persistent Disk, RWO)
    storageClass: premium-rwo
  piAuth:
    # GKE Filestore (NFS, RWX) — requires Filestore CSI driver
    storageClass: standard-rwx
```

- [ ] **Step 2: Create values-openshift.yaml**

Create `charts/multi-agent-harness/values-openshift.yaml`:

```yaml
# OpenShift-specific overrides
# Usage: helm upgrade --install harness charts/multi-agent-harness -f charts/multi-agent-harness/values-openshift.yaml

ingress:
  enabled: false

route:
  enabled: true
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect

# OpenShift assigns arbitrary UIDs — do not set runAsUser
# runAsNonRoot: true is still valid
backend:
  podSecurityContext:
    runAsNonRoot: true

frontend:
  podSecurityContext:
    runAsNonRoot: true

# OpenShift uses oc-managed StorageClasses
persistence:
  data:
    storageClass: ocs-storagecluster-ceph-rbd
  piAuth:
    storageClass: ocs-storagecluster-cephfs
```

---

## Task 11 — Lint and dry-run validate

- [ ] **Step 1: Run helm lint**

```bash
helm lint charts/multi-agent-harness/
```

Expected output:
```
==> Linting charts/multi-agent-harness/
[INFO] Chart.yaml: icon is recommended

1 chart(s) linted, 0 chart(s) failed
```

If lint fails with template errors, fix the reported template file before continuing.

- [ ] **Step 2: Run helm template to verify render**

```bash
helm template test-release charts/multi-agent-harness/ \
  --set secrets.githubToken=ghp_test \
  --set secrets.anthropicApiKey=sk-ant-test
```

Expected: Full YAML output with no `Error:` lines. Check that:
- ConfigMap contains `CONTAINER_RUNTIME: "kubernetes"`
- Backend Deployment references the `harness-agent-runner` serviceAccountName
- Both PVCs are present
- Ingress host is `harness.example.com`

- [ ] **Step 3: Install kubeval and validate (optional but recommended)**

```bash
# Install kubeval if not present
curl -L https://github.com/instrumenta/kubeval/releases/latest/download/kubeval-linux-amd64.tar.gz \
  | tar xz -C /usr/local/bin

helm template test-release charts/multi-agent-harness/ \
  --set secrets.githubToken=ghp_test \
  --set secrets.anthropicApiKey=sk-ant-test \
  | kubeval --ignore-missing-schemas
```

Expected: All resources pass or "Skipping" for CRDs (OpenShift Route is a CRD).

- [ ] **Step 4: Test GKE overlay render**

```bash
helm template test-release charts/multi-agent-harness/ \
  -f charts/multi-agent-harness/values-gke.yaml \
  --set secrets.githubToken=ghp_test \
  --set secrets.anthropicApiKey=sk-ant-test \
  | grep -A5 "kind: Ingress"
```

Expected: `ingressClassName: gce` appears in the Ingress spec.

- [ ] **Step 5: Test OpenShift overlay render — no Ingress, has Route**

```bash
helm template test-release charts/multi-agent-harness/ \
  -f charts/multi-agent-harness/values-openshift.yaml \
  --set secrets.githubToken=ghp_test \
  --set secrets.anthropicApiKey=sk-ant-test \
  | grep "kind:"
```

Expected output contains `kind: Route` and does NOT contain `kind: Ingress`.

- [ ] **Step 6: Commit**

```bash
git add charts/
git commit -m "feat: add Helm chart for Kubernetes deployment (Phase 4)"
```
