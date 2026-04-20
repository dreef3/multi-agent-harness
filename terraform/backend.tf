terraform {
  required_version = ">= 1.5"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }

  # Local backend — state is managed via OCI CLI in CI (see deploy.yml).
  # OCI Object Storage S3-compatible API doesn't support chunked encoding
  # required by the Terraform S3 backend.
  backend "local" {}
}
