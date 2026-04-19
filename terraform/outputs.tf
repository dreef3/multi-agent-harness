output "instance_public_ip" {
  description = "Public IP of the OCI VM (for emergency SSH access)"
  value       = oci_core_instance.harness.public_ip
}

output "instance_id" {
  description = "OCID of the compute instance"
  value       = oci_core_instance.harness.id
}
