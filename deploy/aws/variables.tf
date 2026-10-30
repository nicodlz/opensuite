variable "region" {
  type        = string
  description = "AWS Region supporting SES receiving and Firehose."
  default     = "eu-north-1"
}

variable "initial_recipients" {
  type        = set(string)
  description = "Operator-managed nonempty recipients for the original rule."
  validation {
    condition = length(var.initial_recipients) > 0 && alltrue([
      for recipient in var.initial_recipients : can(regex("^([a-z0-9.!#$%&'+/=?^_`{|}~-]+@)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", recipient))
    ])
    error_message = "Provide at least one lowercase recipient address or domain without wildcards."
  }
}

variable "esuno_initial_recipients" {
  type        = set(string)
  description = "Operator-managed nonempty recipients for the Esuno rule."
  validation {
    condition = length(var.esuno_initial_recipients) > 0 && alltrue([
      for recipient in var.esuno_initial_recipients : can(regex("^([a-z0-9.!#$%&'+/=?^_`{|}~-]+@)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", recipient))
    ])
    error_message = "Provide at least one lowercase recipient address or domain without wildcards."
  }
}

variable "esuno_sending_domains" {
  type        = set(string)
  description = "Explicit Esuno domains authorized for SMTP sending; maintain separately from runtime identity provisioning."
  validation {
    condition = length(var.esuno_sending_domains) > 0 && alltrue([
      for domain in var.esuno_sending_domains : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", domain)) && length(domain) <= 253
    ])
    error_message = "Provide at least one lowercase DNS domain, without wildcards."
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

variable "esuno_message_prefix" {
  type        = string
  description = "Dedicated Esuno object prefix under messages/, ending in a slash."
  default     = "messages/esuno/"
  validation {
    condition     = can(regex("^messages/[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*/$", var.esuno_message_prefix))
    error_message = "Use a dedicated slash-terminated prefix under messages/ without IAM wildcards."
  }
}

variable "sending_iam_user_name" {
  type        = string
  description = "Existing IAM user for SMTP sending; credentials and user are managed outside this module."
}

variable "sending_policy_name" {
  type        = string
  description = "Name of the inline sending policy on the existing IAM user."
  default     = "SendOnlyEsuno"
}

variable "ingestion_queue_name" {
  type        = string
  description = "Existing ingestion queue name, or null to derive it from name_prefix."
  default     = null
}

variable "ingestion_dlq_name" {
  type        = string
  description = "Existing ingestion DLQ name, or null to derive it from name_prefix."
  default     = null
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to supported resources."
  default     = {}
}

variable "activate_rule_set" {
  type        = bool
  description = "Explicitly replace the account's active regional receipt rule set with the original set."
  default     = false
}

variable "alarm_actions" {
  type        = list(string)
  description = "Existing CloudWatch alarm action ARNs; arrange and test operator notifications."
  default     = []
}

variable "domain_adoption_domains" {
  type        = set(string)
  description = "Approved domains for read-only API adoption; empty disables the dedicated IAM user."
  default     = []
  validation {
    condition = alltrue([
      for domain in var.domain_adoption_domains : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", domain)) && length(domain) <= 253
    ])
    error_message = "Use lowercase DNS domains without wildcards."
  }
}
