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
        Action   = ["s3:GetObject", "s3:DeleteObject"]
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
resource "aws_iam_user" "sending" {
  name = "${var.name_prefix}-sending"
}
resource "aws_iam_user_policy" "sending" {
  name = "${var.name_prefix}-sending"
  user = aws_iam_user.sending.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "ses:SendRawEmail"
      Resource = [for identity in aws_ses_domain_identity.domain : identity.arn]
      Condition = {
        StringLike = { "ses:FromAddress" = [for domain in sort(tolist(var.domains)) : "*@${domain}"] }
      }
    }]
  })
}
