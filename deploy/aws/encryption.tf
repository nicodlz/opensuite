variable "state_key" {
  type        = string
  sensitive   = true
  description = "High-entropy passphrase for encrypting state and plans; supply securely during initialization."
}

terraform {
  encryption {
    key_provider "pbkdf2" "local" {
      passphrase = var.state_key
    }
    method "aes_gcm" "local" {
      keys = key_provider.pbkdf2.local
    }
    state {
      method   = method.aes_gcm.local
      enforced = true
    }
    plan {
      method   = method.aes_gcm.local
      enforced = true
    }
  }
}
