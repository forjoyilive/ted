# Ted on your iPhone

The Ted app on your iPhone shows your Inbox while you’re away from your Mac and lets you answer most requests there. It talks to Ted on your Mac through an encrypted relay, so it works on mobile data as well as on Wi-Fi. The relay passes sealed messages along and can’t read them.

“Ted” on the phone pairs only with Ted on the Mac, and “Ted Dev” only with Ted Dev. You can install both on one phone.

## Pair your phone

1. On the Mac, open Settings → Phones and choose **Pair a phone…**. Ted shows a QR code that works for five minutes.
2. Open Ted on your iPhone and scan the code.
3. The phone and the Mac each show a six-digit code. Check they match, then choose **Approve** on the Mac.

The phone asks for Face ID when you open it, and again after it has been in the background for five minutes.

## Notifications

When a request comes in while you’re away from the Mac (2 minutes idle, or its screen locked), each paired phone gets one notification for it. Tapping it opens the request after Face ID. Each request notifies a phone once, even after you snooze it. Nothing is sent for requests that came in while you were using the Mac or before you paired the phone, for a request you’ve already answered or snoozed, or when Inbox notifications are off in Settings.

A notification shows only the request’s title and a short headline, because Apple and Expo deliver it. A permission request’s command is never in a notification.

## What you can answer on the phone

You can answer questions, rounds, permission requests and sign-offs (approve or request changes), and read stops-work problems. The phone can’t answer:

- requests from Coordinator chats,
- design reviews, which have screenshots and files to look at,
- a round being talked through on the Mac,
- choices that need your Mac, such as choosing a simulator to shut down, a Factory to move a Task to, an Asana team, or whether to close pull requests when archiving.

For these the phone says why and asks you to answer on your Mac. Answers you give on the phone count as yours, the same as on the Mac. Draft line comments you started on the Mac aren’t sent with a phone answer.

## Keep your Mac awake with Ted running

The phone reaches Ted only through your Mac, so the Mac must be awake, online and running Ted. If it isn’t, the phone says “Can’t reach your Mac” and keeps showing the last list it had, without letting you send answers.

With **Stay awake while Runs are working** on in Settings → General, Ted also keeps the Mac from sleeping on its own while a phone is paired and a request is waiting, as long as the Mac is on power. With it off, the Mac sleeps on its usual schedule. It can’t stop the Mac sleeping on battery or when you close the lid, so leave it plugged in and open if you want to answer from your phone.

## Remove a lost phone

On the Mac, open Settings → Phones, choose **Remove…** next to the phone and confirm. The relay drops the phone at once: it can’t read or answer anything from then on, and it gets no more notifications. Pair it again if you find it.
