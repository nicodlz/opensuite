data "aws_iam_policy_document" "firehose_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "firehose" {
  name               = "${var.name_prefix}-firehose"
  assume_role_policy = data.aws_iam_policy_document.firehose_trust.json
}

data "aws_iam_policy_document" "firehose" {
  statement {
    actions   = ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.buffer.arn]
  }
  statement {
    actions   = ["s3:AbortMultipartUpload", "s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.buffer.arn}/${local.metadata_prefix}*"]
  }
}
resource "aws_iam_role_policy" "firehose" {
  role   = aws_iam_role.firehose.id
  policy = data.aws_iam_policy_document.firehose.json
}

resource "aws_kinesis_firehose_delivery_stream" "metadata" {
  name        = "${var.name_prefix}-metadata"
  destination = "extended_s3"
  extended_s3_configuration {
    role_arn           = aws_iam_role.firehose.arn
    bucket_arn         = aws_s3_bucket.buffer.arn
    prefix             = local.metadata_prefix
    buffering_interval = 60
    buffering_size     = 5
    compression_format = "GZIP"
    processing_configuration {
      enabled = true
      processors {
        type = "AppendDelimiterToRecord"
      }
    }
  }
  depends_on = [aws_iam_role_policy.firehose, aws_s3_bucket_server_side_encryption_configuration.buffer]
}

data "aws_iam_policy_document" "sns_firehose_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "sns_firehose" {
  name               = "${var.name_prefix}-sns-firehose"
  assume_role_policy = data.aws_iam_policy_document.sns_firehose_trust.json
}
resource "aws_iam_role_policy" "sns_firehose" {
  role = aws_iam_role.sns_firehose.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["firehose:PutRecord", "firehose:PutRecordBatch"]
      Resource = aws_kinesis_firehose_delivery_stream.metadata.arn
    }]
  })
}
