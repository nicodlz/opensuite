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
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = !var.activate_esuno_rule_set
      error_message = "Only one receipt rule set can be active."
    }
  }
}

# Activation is separately opt-in and must be imported when already active.
resource "aws_ses_receipt_rule_set" "esuno" {
  rule_set_name = local.esuno_rule_set_name
  lifecycle {
    prevent_destroy = true
  }
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
    prevent_destroy = true
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

resource "aws_ses_active_receipt_rule_set" "esuno" {
  count         = var.activate_esuno_rule_set ? 1 : 0
  rule_set_name = aws_ses_receipt_rule_set.esuno.rule_set_name
  depends_on    = [aws_ses_receipt_rule.esuno]
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = !var.activate_rule_set
      error_message = "Only one receipt rule set can be active."
    }
  }
}
