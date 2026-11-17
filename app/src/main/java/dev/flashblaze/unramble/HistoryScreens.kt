package dev.flashblaze.unramble

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.util.Log
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.FilledIconButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import kotlinx.coroutines.delay
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** "Today 08:53", "Yesterday 19:02", "Sun 15 Nov 10:30" in the watch's zone. */
private fun whenLabel(createdAt: Long): String {
    val at = Instant.ofEpochMilli(createdAt).atZone(ZoneId.systemDefault())
    val today = LocalDate.now()
    val day = when (at.toLocalDate()) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> at.format(DateTimeFormatter.ofPattern("EEE d MMM"))
    }
    return "$day ${at.format(DateTimeFormatter.ofPattern("HH:mm"))}"
}

private fun summary(entry: HistoryEntry): String = when {
    entry.outcome == "no_speech" -> "No speech heard"
    entry.kept.isNotEmpty() -> "✓${entry.created} · ${entry.kept.joinToString(", ") { it.title }}"
    entry.proposed.isNotEmpty() -> entry.proposed.joinToString(", ") { it.title }
    else -> entry.transcript ?: ""
}

@Composable
fun HistoryListScreen(viewModel: MainViewModel, onOpen: (String) -> Unit) {
    val entries by viewModel.history.collectAsStateWithLifecycle()
    ListScreen(edgeButton = null) {
        item { ListHeader { Text(stringResource(R.string.history)) } }
        if (entries.isEmpty()) {
            item {
                Text(
                    stringResource(R.string.no_history),
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        for (entry in entries) {
            item(key = entry.id) {
                Button(
                    onClick = { onOpen(entry.id) },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.filledTonalButtonColors(),
                    secondaryLabel = { Text(summary(entry), maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    label = { Text(whenLabel(entry.createdAt)) },
                )
            }
        }
        if (entries.isNotEmpty()) {
            item { SecondaryAction(stringResource(R.string.erase_all), viewModel::clearHistory) }
        }
    }
}

/** True when there's something to play through: the watch speaker or a Bluetooth headset. */
private fun hasAudioOutput(context: Context): Boolean {
    val outputs = context.getSystemService(AudioManager::class.java).getDevices(AudioManager.GET_DEVICES_OUTPUTS)
    return outputs.any {
        it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER ||
            it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
            it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
    }
}

private val SPEECH = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

private fun formatMs(ms: Int): String = "%d:%02d".format(ms / 60_000, ms / 1000 % 60)

@Composable
fun HistoryDetailScreen(viewModel: MainViewModel, id: String, onDeleted: () -> Unit) {
    val entries by viewModel.history.collectAsStateWithLifecycle()
    val entry = entries.firstOrNull { it.id == id } ?: return
    val audio = viewModel.historyAudio(id)
    val context = LocalContext.current
    val today = LocalDate.now()
    var playing by remember { mutableStateOf(false) }
    var position by remember { mutableIntStateOf(0) }
    val player = rememberPlayer(audio, onComplete = { playing = false; position = 0 })
    val duration = player?.duration?.coerceAtLeast(1) ?: 1
    val audioManager = remember { context.getSystemService(AudioManager::class.java) }
    val focus = remember { AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(SPEECH).build() }

    fun pause() {
        player?.takeIf { it.isPlaying }?.pause()
        playing = false
        audioManager.abandonAudioFocusRequest(focus)
    }

    LaunchedEffect(playing) {
        while (playing && player != null) {
            position = player.currentPosition
            delay(200)
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_PAUSE) { pause() }
    DisposableEffect(Unit) { onDispose { audioManager.abandonAudioFocusRequest(focus) } }

    val canPlay = player != null && remember { hasAudioOutput(context) }
    ListScreen(edgeButton = null) {
        item { ListHeader { Text(whenLabel(entry.createdAt)) } }
        item {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(progress = { position.toFloat() / duration }, modifier = Modifier.size(84.dp))
                    FilledIconButton(
                        enabled = canPlay,
                        modifier = Modifier.size(56.dp),
                        onClick = {
                            if (playing) {
                                pause()
                            } else if (audioManager.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                                player?.start()
                                playing = true
                            }
                        },
                    ) {
                        Icon(
                            painterResource(if (playing) R.drawable.ic_pause else R.drawable.ic_play),
                            contentDescription = stringResource(if (playing) R.string.pause else R.string.play),
                            modifier = Modifier.size(28.dp),
                        )
                    }
                }
                Text(
                    if (canPlay) "${formatMs(position)} / ${formatMs(duration)}" else stringResource(R.string.no_speaker),
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
        entry.transcript?.let { transcript ->
            item { Text("“$transcript”", style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp)) }
        }
        val keptTitles = entry.kept.map { it.title }.toSet()
        for (task in entry.proposed) {
            item {
                val mark = if (task.title in keptTitles) "✓" else "·"
                val due = task.due?.let { " · ${dueLabel(it, today)}" }.orEmpty()
                Text("$mark ${task.title}$due", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp))
            }
        }
        item {
            SecondaryAction(stringResource(R.string.delete_from_watch)) {
                pause()
                viewModel.deleteFromHistory(id)
                onDeleted()
            }
        }
    }
}

/** A prepared MediaPlayer for [file], released with the screen; null when the file can't be played. */
@Composable
private fun rememberPlayer(file: File, onComplete: () -> Unit): MediaPlayer? {
    val player = remember(file) {
        runCatching {
            MediaPlayer().apply {
                setAudioAttributes(SPEECH)
                setDataSource(file.path)
                prepare()
            }
        }.onFailure { Log.w("History", "Can't play recording", it) }.getOrNull()
    }
    DisposableEffect(player) {
        player?.setOnCompletionListener { onComplete() }
        onDispose { player?.release() }
    }
    return player
}
