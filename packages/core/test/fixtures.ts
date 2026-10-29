// Fixture follows https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-examples.html
// and https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html
export function notification(
  recipients = ["alice@example.test", "hidden@example.test"],
  status = "PASS",
  messageId = "ses-1",
) {
  const verdict = { status };
  return {
    notificationType: "Received",
    receipt: {
      timestamp: "2026-01-02T03:04:05.000Z",
      processingTimeMillis: 100,
      recipients,
      spamVerdict: verdict,
      virusVerdict: verdict,
      spfVerdict: verdict,
      dkimVerdict: verdict,
      dmarcVerdict: verdict,
      action: {
        type: "S3",
        topicArn: "arn:aws:sns:eu-north-1:123456789012:inbound",
        bucketName: "inbound",
        objectKey: messageId,
      },
    },
    mail: {
      timestamp: "2026-01-02T03:04:05.000Z",
      source: "sender@example.test",
      messageId,
      destination: ["alice@example.test"],
      headersTruncated: false,
      headers: [],
      commonHeaders: {},
    },
  };
}
