resource "aws_ses_receipt_rule_set" "inbound" {
  rule_set_name = local.rule_set_name
}

resource "aws_ses_receipt_rule" "inbound" {
  name          = local.rule_name
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
  recipients    = sort(tolist(var.initial_recipients))
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Optional"

  s3_action {
    bucket_name       = aws_s3_bucket.buffer.id
    object_key_prefix = local.message_prefix
    topic_arn         = aws_sns_topic.inbound.arn
    position          = 1
  }

  # SES domain management owns this field after initial creation.
  lifecycle {
    ignore_changes = [recipients]
  }

  depends_on = [
    aws_s3_bucket_policy.buffer,
    aws_s3_bucket_server_side_encryption_configuration.buffer,
    aws_s3_bucket_public_access_block.buffer,
    aws_sns_topic_policy.inbound,
    aws_sns_topic_subscription.ingestion,
    aws_sns_topic_subscription.archive,
  ]
}

resource "aws_ses_active_receipt_rule_set" "inbound" {
  count         = var.activate_rule_set ? 1 : 0
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
  depends_on    = [aws_ses_receipt_rule.inbound]
}

# This rule set is defined but is not activated by this module.
resource "aws_ses_receipt_rule_set" "esuno" {
  rule_set_name = local.esuno_rule_set_name
}

resource "aws_ses_receipt_rule" "esuno" {
  name          = local.esuno_rule_name
  rule_set_name = aws_ses_receipt_rule_set.esuno.rule_set_name
  recipients    = sort(tolist(var.esuno_initial_recipients))
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Optional"

  s3_action {
    bucket_name       = aws_s3_bucket.buffer.id
    object_key_prefix = var.esuno_message_prefix
    topic_arn         = aws_sns_topic.inbound.arn
    position          = 1
  }

  lifecycle {
    ignore_changes = [recipients]
  }

  depends_on = [
    aws_s3_bucket_policy.buffer,
    aws_s3_bucket_server_side_encryption_configuration.buffer,
    aws_s3_bucket_public_access_block.buffer,
    aws_sns_topic_policy.inbound,
    aws_sns_topic_subscription.ingestion,
    aws_sns_topic_subscription.archive,
  ]
}
