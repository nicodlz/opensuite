# Calendar reminders

Enable calendar notifications on each device where you want to receive them.
Set a reminder in the calendar event editor or in a CalDAV client. Existing
custom alarms are preserved unless you change the reminder. The privacy setting controls
whether notifications show the event title, time and location. A generic
notification says “Upcoming event”.

The server checks for calendar changes approximately once a minute. After an
outage it sends reminders up to 15 minutes late and skips older ones. All-day
and floating events use the time zone of the most recently registered or active
calendar notification device; older subscriptions use UTC until that device
opens Calendar or re-enables notifications. Delivery depends on the
push provider and device being online within the notification's lifetime.
