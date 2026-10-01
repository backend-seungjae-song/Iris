package app.iris.iris_remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

class KeepAliveService : Service() {
    companion object {
        const val ACTION_START = "iris.remote.keepalive.START"
        const val ACTION_UPDATE = "iris.remote.keepalive.UPDATE"
        const val ACTION_STOP = "iris.remote.keepalive.STOP"
        const val EXTRA_REQUEST_COUNT = "requestCount"
        const val EXTRA_DISCONNECTED = "disconnected"

        private const val CONNECTION_CHANNEL = "iris.remote.connection"
        private const val REQUEST_CHANNEL = "iris.remote.requests"
        private const val CONNECTION_NOTIFICATION = 4100
        private const val REQUEST_NOTIFICATION = 4101
    }

    private lateinit var notifications: NotificationManager
    private var foreground = false
    private var requestCount = 0

    override fun onCreate() {
        super.onCreate()
        notifications = getSystemService(NotificationManager::class.java)
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startForegroundConnection()
            ACTION_UPDATE -> updateRequests(
                intent.getIntExtra(EXTRA_REQUEST_COUNT, requestCount),
            )
            ACTION_STOP -> stopConnection(
                disconnected = intent.getBooleanExtra(EXTRA_DISCONNECTED, false),
            )
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannels() {
        notifications.createNotificationChannel(
            NotificationChannel(
                CONNECTION_CHANNEL,
                "Iris 연결",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Iris 원격 연결 상태"
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            },
        )
        notifications.createNotificationChannel(
            NotificationChannel(
                REQUEST_CHANNEL,
                "Iris 응답 요청",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "응답이 필요한 요청 수"
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            },
        )
    }

    private fun startForegroundConnection() {
        if (foreground) return
        startForeground(
            CONNECTION_NOTIFICATION,
            notification(CONNECTION_CHANNEL, "Iris에 연결됨", ongoing = true),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
        foreground = true
    }

    private fun updateRequests(count: Int) {
        if (!foreground) return
        val increased = count > requestCount
        requestCount = count
        if (count <= 0) {
            notifications.cancel(REQUEST_NOTIFICATION)
            return
        }
        notifications.notify(
            REQUEST_NOTIFICATION,
            notification(
                REQUEST_CHANNEL,
                "응답 요청 ${count}건",
                onlyAlertOnce = !increased,
            ),
        )
    }

    private fun stopConnection(disconnected: Boolean) {
        if (disconnected) {
            notifications.notify(
                REQUEST_NOTIFICATION,
                notification(REQUEST_CHANNEL, "연결이 끊겼습니다"),
            )
        } else {
            notifications.cancel(REQUEST_NOTIFICATION)
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        foreground = false
        stopSelf()
    }

    private fun notification(
        channel: String,
        title: String,
        ongoing: Boolean = false,
        onlyAlertOnce: Boolean = false,
    ): Notification {
        val launch = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_stat_iris)
            .setContentTitle(title)
            .setContentIntent(pendingIntent)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOngoing(ongoing)
            .setOnlyAlertOnce(onlyAlertOnce)
            .setAutoCancel(!ongoing)
            .build()
    }
}
