variable "tenancy_ocid" {
  description = "OCI tenancy OCID"
  type        = string
  sensitive   = true
}

variable "user_ocid" {
  description = "OCI user OCID"
  type        = string
  sensitive   = true
}

variable "fingerprint" {
  description = "OCI API key fingerprint"
  type        = string
  sensitive   = true
}

variable "private_key" {
  description = "OCI API private key (PEM content)"
  type        = string
  sensitive   = true
}

variable "region" {
  description = "OCI region (e.g. eu-frankfurt-1)"
  type        = string
}

variable "compartment_id" {
  description = "OCI compartment OCID where resources are created"
  type        = string
}

variable "ssh_public_key" {
  description = "SSH public key to install on the VM (for deploy user)"
  type        = string
}

variable "tailscale_auth_key" {
  description = "Tailscale auth key for the VM to join the tailnet"
  type        = string
  sensitive   = true
}

variable "instance_ocpus" {
  description = "Number of OCPUs for the ARM instance"
  type        = number
  default     = 4
}

variable "instance_memory_gb" {
  description = "RAM in GB for the ARM instance"
  type        = number
  default     = 24
}

variable "availability_domain_index" {
  description = "Index into the list of availability domains (0, 1, or 2). Change if the chosen AD is out of capacity."
  type        = number
  default     = 0
}
