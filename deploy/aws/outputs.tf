output "region" { value = var.region }
output "buffer_bucket" { value = aws_s3_bucket.buffer.id }
output "message_prefix" { value = local.message_prefix }
output "metadata_prefix" { value = local.metadata_prefix }
output "ingestion_queue_url" { value = aws_sqs_queue.ingestion.url }
output "ingestion_dlq_url" { value = aws_sqs_queue.ingestion_dlq.url }
output "subscription_dlq_url" { value = aws_sqs_queue.subscription_dlq.url }
output "inbound_topic_arn" { value = aws_sns_topic.inbound.arn }
output "ingestion_iam_user" { value = aws_iam_user.ingestion.name }
output "sending_iam_user" { value = aws_iam_user.sending.name }
output "smtp_host" { value = "email-smtp.${var.region}.amazonaws.com" }
output "smtp_starttls_port" { value = 2587 }
output "receipt_rule_set" { value = aws_ses_receipt_rule_set.inbound.rule_set_name }
output "dns_records" {
  description = "Publish identity TXT, Easy DKIM CNAMEs, MAIL FROM MX and SPF TXT; also configure receiving MX."
  value = {
    for domain in sort(tolist(var.domains)) : domain => {
      verification = { name = "_amazonses.${domain}", type = "TXT", value = aws_ses_domain_identity.domain[domain].verification_token }
      dkim = [for token in aws_ses_domain_dkim.domain[domain].dkim_tokens : {
        name = "${token}._domainkey.${domain}", type = "CNAME", value = "${token}.dkim.amazonses.com"
      }]
      mail_from_mx  = { name = aws_ses_domain_mail_from.domain[domain].mail_from_domain, type = "MX", value = "10 feedback-smtp.${var.region}.amazonses.com" }
      mail_from_spf = { name = aws_ses_domain_mail_from.domain[domain].mail_from_domain, type = "TXT", value = "v=spf1 include:amazonses.com -all" }
      receiving_mx  = { name = domain, type = "MX", value = "10 inbound-smtp.${var.region}.amazonaws.com" }
    }
  }
}
