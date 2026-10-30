# Credentials are provisioned and rotated outside state, by the operator.
resource "aws_iam_user" "ingestion" {
  name = "${var.name_prefix}-ingestion"
}
resource "aws_iam_user_policy" "ingestion" {
  name = "${var.name_prefix}-ingestion"
  user = aws_iam_user.ingestion.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.buffer.arn}/${local.message_prefix}*"
      },
      {
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = aws_s3_bucket.buffer.arn
        Condition = { StringLike = { "s3:prefix" = ["${local.message_prefix}*"] } }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.buffer.arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.ingestion.arn
      }
    ]
  })
}
# The sending user and credentials are provisioned outside this module.
resource "aws_iam_user_policy" "sending" {
  name = var.sending_policy_name
  user = var.sending_iam_user_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "SendFromEsunoOnly"
      Effect   = "Allow"
      Action   = "ses:SendRawEmail"
      Resource = [for domain in sort(tolist(var.esuno_sending_domains)) : "arn:${data.aws_partition.current.partition}:ses:${var.region}:${data.aws_caller_identity.current.account_id}:identity/${domain}"]
      Condition = {
        StringLike = { "ses:FromAddress" = [for domain in sort(tolist(var.esuno_sending_domains)) : "*@${domain}"] }
      }
    }]
  })
}

resource "aws_iam_user_policy" "ingest_esuno_delete" {
  name = "${var.name_prefix}-esuno-delete"
  user = aws_iam_user.ingestion.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "s3:DeleteObject"
      Resource = "${aws_s3_bucket.buffer.arn}/${var.esuno_message_prefix}*"
    }]
  })
}

# Opt-in read-only adoption principal; credentials are provisioned outside state.
resource "aws_iam_user" "domain_adoption" {
  count = length(var.domain_adoption_domains) > 0 ? 1 : 0
  name  = "${var.name_prefix}-domain-adoption"
}

resource "aws_iam_user_policy" "domain_adoption" {
  count = length(var.domain_adoption_domains) > 0 ? 1 : 0
  name  = "${var.name_prefix}-domain-adoption"
  user  = aws_iam_user.domain_adoption[0].name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadApprovedIdentities"
        Effect   = "Allow"
        Action   = "ses:GetEmailIdentity"
        Resource = [for domain in sort(tolist(var.domain_adoption_domains)) : "arn:${data.aws_partition.current.partition}:ses:${var.region}:${data.aws_caller_identity.current.account_id}:identity/${domain}"]
      },
      {
        Sid       = "ReadRegionalSesMetadata"
        Effect    = "Allow"
        Action    = ["ses:GetIdentityVerificationAttributes", "ses:DescribeActiveReceiptRuleSet", "ses:DescribeReceiptRule"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }
      }
    ]
  })
}
