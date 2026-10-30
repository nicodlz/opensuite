locals {
  alarms = {
    ingestion-age = {
      namespace  = "AWS/SQS"
      metric     = "ApproximateAgeOfOldestMessage"
      dimensions = { QueueName = aws_sqs_queue.ingestion.name }
      statistic  = "Maximum"
      threshold  = 3600
    }
    ingestion-dlq = {
      namespace  = "AWS/SQS"
      metric     = "ApproximateNumberOfMessagesVisible"
      dimensions = { QueueName = aws_sqs_queue.ingestion_dlq.name }
      statistic  = "Maximum"
      threshold  = 1
    }
    subscription-dlq = {
      namespace  = "AWS/SQS"
      metric     = "ApproximateNumberOfMessagesVisible"
      dimensions = { QueueName = aws_sqs_queue.subscription_dlq.name }
      statistic  = "Maximum"
      threshold  = 1
    }
    sns-failures = {
      namespace  = "AWS/SNS"
      metric     = "NumberOfNotificationsFailed"
      dimensions = { TopicName = aws_sns_topic.inbound.name }
      statistic  = "Sum"
      threshold  = 1
    }
    archive-age = {
      namespace  = "AWS/Firehose"
      metric     = "DeliveryToS3.DataFreshness"
      dimensions = { DeliveryStreamName = aws_kinesis_firehose_delivery_stream.metadata.name }
      statistic  = "Maximum"
      threshold  = 3600
    }
  }
}
resource "aws_cloudwatch_metric_alarm" "inbound" {
  for_each            = local.alarms
  alarm_name          = "${var.name_prefix}-${each.key}"
  alarm_description   = "OpenSuite ${each.key}; investigate and recover before retention expires."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  period              = 300
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dimensions
  statistic           = each.value.statistic
  threshold           = each.value.threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}
