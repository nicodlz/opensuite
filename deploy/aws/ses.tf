resource "aws_ses_domain_identity" "domain" {
  for_each = var.domains
  domain   = each.value
}

resource "aws_ses_domain_dkim" "domain" {
  for_each = aws_ses_domain_identity.domain
  domain   = each.value.domain
}

resource "aws_ses_domain_mail_from" "domain" {
  for_each               = aws_ses_domain_identity.domain
  domain                 = each.value.domain
  mail_from_domain       = "${var.mail_from_subdomain}.${each.value.domain}"
  behavior_on_mx_failure = "RejectMessage"
}

resource "aws_ses_receipt_rule_set" "inbound" {
  rule_set_name = local.rule_set_name
}

resource "aws_ses_receipt_rule" "inbound" {
  name          = local.rule_name
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
  recipients    = sort(tolist(var.recipients))
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
}
