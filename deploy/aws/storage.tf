locals {
  message_prefix      = "messages/"
  metadata_prefix     = "metadata/"
  rule_set_name       = "${var.name_prefix}-inbound"
  rule_name           = "${var.name_prefix}-store"
  esuno_rule_set_name = "${var.name_prefix}-esuno-inbound"
  esuno_rule_name     = "${var.name_prefix}-esuno-store"
  esuno_rule_arn      = "arn:${data.aws_partition.current.partition}:ses:${var.region}:${data.aws_caller_identity.current.account_id}:receipt-rule-set/${local.esuno_rule_set_name}:receipt-rule/${local.esuno_rule_name}"
  rule_arn            = "arn:${data.aws_partition.current.partition}:ses:${var.region}:${data.aws_caller_identity.current.account_id}:receipt-rule-set/${local.rule_set_name}:receipt-rule/${local.rule_name}"
}

resource "aws_s3_bucket" "buffer" {
  bucket = var.buffer_bucket_name
  tags   = { Purpose = "Inbound" }
}

resource "aws_s3_bucket_versioning" "buffer" {
  bucket = aws_s3_bucket.buffer.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "buffer" {
  bucket                  = aws_s3_bucket.buffer.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "buffer" {
  bucket = aws_s3_bucket.buffer.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# S3 has one lifecycle configuration per bucket; reconcile all other required rules before adoption.
resource "aws_s3_bucket_lifecycle_configuration" "buffer" {
  bucket = aws_s3_bucket.buffer.id
  rule {
    id     = "esuno-recover-deleted-messages"
    status = "Enabled"
    filter {
      prefix = var.esuno_message_prefix
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.buffer.arn,
      "${aws_s3_bucket.buffer.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  statement {
    sid       = "AllowReceiptRule"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.buffer.arn}/${local.message_prefix}*"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnEquals"
      variable = "AWS:SourceArn"
      values   = [local.rule_arn]
    }
  }
  statement {
    sid       = "AllowEsunoReceiptRule"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.buffer.arn}/${var.esuno_message_prefix}*"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnEquals"
      variable = "AWS:SourceArn"
      values   = [local.esuno_rule_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "buffer" {
  bucket = aws_s3_bucket.buffer.id
  policy = data.aws_iam_policy_document.bucket.json
}
