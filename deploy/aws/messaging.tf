resource "aws_sns_topic" "inbound" {
  name = "${var.name_prefix}-inbound"
}

data "aws_iam_policy_document" "topic" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["SNS:*"]
    resources = [aws_sns_topic.inbound.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  statement {
    sid       = "ReceiptRulePublish"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.inbound.arn]
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
    sid       = "EsunoReceiptRulePublish"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.inbound.arn]
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

resource "aws_sns_topic_policy" "inbound" {
  arn    = aws_sns_topic.inbound.arn
  policy = data.aws_iam_policy_document.topic.json
}

resource "aws_sqs_queue" "ingestion_dlq" {
  name = coalesce(var.ingestion_dlq_name, "${var.name_prefix}-inbound-dlq")
  tags = { Purpose = "InboundDLQ" }
  lifecycle {
    ignore_changes = [max_message_size]
  }
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "ingestion" {
  name = coalesce(var.ingestion_queue_name, "${var.name_prefix}-inbound")
  tags = { Purpose = "Inbound" }
  lifecycle {
    ignore_changes = [max_message_size]
  }
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 300
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ingestion_dlq.arn
    maxReceiveCount     = 100
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "ingestion_dlq" {
  queue_url = aws_sqs_queue.ingestion_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.ingestion.arn]
  })
}

# SNS delivery failures (distinct from worker failures) are retained here.
resource "aws_sqs_queue" "subscription_dlq" {
  name                      = "${var.name_prefix}-sns-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

data "aws_iam_policy_document" "queue" {
  for_each = {
    ingestion        = aws_sqs_queue.ingestion.arn
    subscription_dlq = aws_sqs_queue.subscription_dlq.arn
  }
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [each.value]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
    condition {
      test     = "Bool"
      variable = "aws:PrincipalIsAWSService"
      values   = ["false"]
    }
  }
  statement {
    sid       = "AllowOnlyInboundTopic"
    actions   = ["sqs:SendMessage"]
    resources = [each.value]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.inbound.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "ingestion" {
  queue_url = aws_sqs_queue.ingestion.id
  policy    = data.aws_iam_policy_document.queue["ingestion"].json
}
resource "aws_sqs_queue_policy" "subscription_dlq" {
  queue_url = aws_sqs_queue.subscription_dlq.id
  policy    = data.aws_iam_policy_document.queue["subscription_dlq"].json
}

resource "aws_sns_topic_subscription" "ingestion" {
  topic_arn            = aws_sns_topic.inbound.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.ingestion.arn
  raw_message_delivery = true
  redrive_policy       = jsonencode({ deadLetterTargetArn = aws_sqs_queue.subscription_dlq.arn })
  depends_on           = [aws_sqs_queue_policy.ingestion, aws_sqs_queue_policy.subscription_dlq]
}

resource "aws_sns_topic_subscription" "archive" {
  topic_arn             = aws_sns_topic.inbound.arn
  protocol              = "firehose"
  endpoint              = aws_kinesis_firehose_delivery_stream.metadata.arn
  subscription_role_arn = aws_iam_role.sns_firehose.arn
  raw_message_delivery  = true
  redrive_policy        = jsonencode({ deadLetterTargetArn = aws_sqs_queue.subscription_dlq.arn })
  depends_on            = [aws_iam_role_policy.sns_firehose, aws_sqs_queue_policy.subscription_dlq]
}
