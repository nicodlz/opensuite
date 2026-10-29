variable "region" {
  type        = string
  description = "AWS Region supporting SES receiving and Firehose."
  default     = "eu-north-1"
}

variable "domains" {
  type        = set(string)
  description = "Explicit lowercase SES domain identities."
  validation {
    condition = length(var.domains) > 0 && alltrue([
      for domain in var.domains : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", domain)) && length(domain) <= 253
    ])
    error_message = "Provide at least one lowercase DNS domain, without wildcards."
  }
}

variable "recipients" {
  type        = set(string)
  description = "Explicit receipt-rule addresses or domains; never an empty catch-all."
  validation {
    condition = length(var.recipients) > 0 && alltrue([
      for recipient in var.recipients : can(regex("^([a-z0-9.!#$%&'+/=?^_`{|}~-]+@)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", recipient))
    ])
    error_message = "Provide at least one lowercase recipient address or domain without wildcards."
  }
}

variable "name_prefix" {
  type        = string
  description = "Prefix for named resources, unique in the account and region."
  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$", var.name_prefix))
    error_message = "Use 1-31 letters, digits, underscores or hyphens, starting with a letter or digit."
  }
}

variable "buffer_bucket_name" {
  type        = string
  description = "Globally unique S3 bucket name chosen by the operator."
}

variable "mail_from_subdomain" {
  type        = string
  description = "Single DNS label prepended to each identity for custom MAIL FROM."
  default     = "bounce"
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.mail_from_subdomain))
    error_message = "Use one lowercase DNS label."
  }
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to supported resources."
  default     = {}
}

variable "activate_rule_set" {
  type        = bool
  description = "Explicitly replace the account's active regional receipt rule set."
  default     = false
}

variable "alarm_actions" {
  type        = list(string)
  description = "Existing CloudWatch alarm action ARNs; arrange and test operator notifications."
  default     = []
}

variable "confirmed_expiration_days" {
  type        = number
  description = "Safety expiration for explicitly confirmed imported objects only."
  default     = 90
  validation {
    condition     = var.confirmed_expiration_days >= 30 && floor(var.confirmed_expiration_days) == var.confirmed_expiration_days
    error_message = "Use an integer of at least 30 days, well above SQS's 14-day retention."
  }
}
