package dev.flashblaze.unramble

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File

sealed interface RecorderState {
    data object Idle : RecorderState
    data class Recording(val startedAtElapsed: Long) : RecorderState
    data class Finished(val file: File) : RecorderState
    data class Failed(val reason: String) : RecorderState
}

/** Process-wide recorder state: written by [RecorderService], consumed (and reset to Idle) by the ViewModel. */
object Recorder {
    val state = MutableStateFlow<RecorderState>(RecorderState.Idle)
}

/**
 * Foreground service (type microphone) so dictation keeps recording with the screen off.
 * Ogg/Opus, 16 kHz mono, 24 kbps: about 800 KB for the 5-minute cap (see PLAN.md, Phase 0).
 */
class RecorderService : Service() {
    private var recorder: MediaRecorder? = null
    private lateinit var output: File

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> start()
            ACTION_STOP -> finish(keep = true)
            ACTION_CANCEL -> finish(keep = false)
        }
        return START_NOT_STICKY
    }

    private fun start() {
        if (recorder != null) return
        val startedAt = SystemClock.elapsedRealtime()
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(startedAt), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        output = File(cacheDir, "dictation.ogg").apply { delete() }
        val mediaRecorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
        try {
            mediaRecorder.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.OGG)
                setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
                setAudioSamplingRate(16_000)
                setAudioChannels(1)
                setAudioEncodingBitRate(24_000)
                setMaxDuration(MAX_DURATION_MS)
                setOutputFile(output)
                setOnInfoListener { _, what, _ ->
                    if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) finish(keep = true)
                }
                prepare()
                start()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Recorder failed to start", e)
            mediaRecorder.release()
            stop(RecorderState.Failed("Couldn't start the microphone"))
            return
        }
        recorder = mediaRecorder
        Recorder.state.value = RecorderState.Recording(startedAt)
    }

    private fun finish(keep: Boolean) {
        val mediaRecorder = recorder ?: return
        recorder = null
        // stop() throws when nothing was captured (e.g. a tap-tap) or after the max-duration auto-stop.
        runCatching { mediaRecorder.stop() }.onFailure { Log.w(TAG, "MediaRecorder.stop failed", it) }
        mediaRecorder.release()
        val result = when {
            !keep -> RecorderState.Idle.also { output.delete() }
            output.length() > MIN_AUDIO_BYTES -> RecorderState.Finished(output)
            else -> RecorderState.Failed("Recording too short")
        }
        stop(result)
    }

    private fun stop(result: RecorderState) {
        Recorder.state.value = result
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        recorder?.release()
        recorder = null
        super.onDestroy()
    }

    private fun notification(startedAtElapsed: Long): android.app.Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, getString(R.string.recording), NotificationManager.IMPORTANCE_LOW))
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_mic)
            .setContentTitle(getString(R.string.recording))
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setOngoing(true)
            .setContentIntent(openApp)
        OngoingActivity.Builder(applicationContext, NOTIFICATION_ID, builder)
            .setStaticIcon(R.drawable.ic_mic)
            .setTouchIntent(openApp)
            .setStatus(
                Status.Builder()
                    .addTemplate("#time#")
                    // StopwatchPart counts from an elapsedRealtime() base, same as startedAtElapsed.
                    .addPart("time", Status.StopwatchPart(startedAtElapsed))
                    .build(),
            )
            .build()
            .apply(applicationContext)
        return builder.build()
    }

    companion object {
        private const val TAG = "RecorderService"
        private const val ACTION_START = "start"
        private const val ACTION_STOP = "stop"
        private const val ACTION_CANCEL = "cancel"
        private const val CHANNEL_ID = "recording"
        private const val NOTIFICATION_ID = 1
        const val MAX_DURATION_MS = 5 * 60 * 1000

        /** An Ogg/Opus file with headers but no audio is a few hundred bytes. */
        private const val MIN_AUDIO_BYTES = 2_048L

        /** Call only while the app is visible: Android 14+ forbids starting microphone services from the background. */
        fun start(context: Context) =
            ContextCompat.startForegroundService(context, Intent(context, RecorderService::class.java).setAction(ACTION_START))

        fun stop(context: Context) {
            context.startService(Intent(context, RecorderService::class.java).setAction(ACTION_STOP))
        }

        fun cancel(context: Context) {
            context.startService(Intent(context, RecorderService::class.java).setAction(ACTION_CANCEL))
        }
    }
}
