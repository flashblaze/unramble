package dev.flashblaze.unramble

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.TransformingLazyColumnScope
import androidx.wear.compose.foundation.lazy.itemsIndexed
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.CheckboxButton
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.EdgeButton
import androidx.wear.compose.material3.FilledIconButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.CompactButton
import kotlinx.coroutines.delay
import java.time.LocalDate
import java.time.format.DateTimeFormatter

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { AppScaffold { UnrambleNavHost() } } }
    }
}

/** Record flow plus the on-watch history; swipe right to go back (Wear's swipe-to-dismiss). */
@Composable
fun UnrambleNavHost(viewModel: MainViewModel = viewModel()) {
    val nav = rememberSwipeDismissableNavController()
    SwipeDismissableNavHost(navController = nav, startDestination = "main") {
        composable("main") { UnrambleApp(viewModel, onOpenHistory = { nav.navigate("history") }) }
        composable("history") { HistoryListScreen(viewModel, onOpen = { id -> nav.navigate("history/$id") }) }
        composable("history/{id}") { entry ->
            HistoryDetailScreen(viewModel, entry.arguments?.getString("id").orEmpty(), onDeleted = { nav.popBackStack() })
        }
    }
}

@Composable
fun UnrambleApp(viewModel: MainViewModel, onOpenHistory: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[Manifest.permission.RECORD_AUDIO] == true) viewModel.record() else viewModel.micPermissionDenied()
    }
    val record = {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            viewModel.record()
        } else {
            // Notifications power the recording chip on the watch face; the mic is the only hard requirement.
            permissions.launch(
                if (Build.VERSION.SDK_INT >= 33) {
                    arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS)
                } else {
                    arrayOf(Manifest.permission.RECORD_AUDIO)
                },
            )
        }
    }

    when (val s = state) {
        UiState.Idle -> IdleScreen(onRecord = record, onHistory = onOpenHistory)
        is UiState.Recording -> RecordingScreen(s.startedAtElapsed, viewModel::stopRecording, viewModel::cancelRecording)
        UiState.Uploading -> ProgressScreen(stringResource(R.string.finding_tasks))
        UiState.Creating -> ProgressScreen(stringResource(R.string.creating_tasks))
        is UiState.Review -> ReviewScreen(s, viewModel::toggle, viewModel::createSelected, viewModel::reset)
        is UiState.Done -> DoneScreen(s, onRetry = viewModel::create, onDone = viewModel::reset)
        is UiState.NothingHeard -> MessageScreen(s.message, stringResource(R.string.record_again), onAction = record)
        is UiState.Error -> MessageScreen(
            message = s.message,
            action = stringResource(if (s.retry == Retry.RecordAgain) R.string.record_again else R.string.retry),
            onAction = when (s.retry) {
                Retry.Upload -> viewModel::upload
                Retry.Create -> viewModel::create
                Retry.RecordAgain -> record
            },
            onDismiss = viewModel::reset,
        )
        UiState.MicPermissionDenied -> MessageScreen(
            message = stringResource(R.string.mic_denied),
            action = stringResource(R.string.open_settings),
            onAction = {
                context.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
                )
            },
            onDismiss = viewModel::reset,
        )
    }
}

/** Every screen is a list so long text scrolls on the round display and the edge button hugs the bottom. */
@Composable
internal fun ListScreen(
    edgeButton: (@Composable () -> Unit)?,
    content: TransformingLazyColumnScope.() -> Unit,
) {
    val listState = rememberTransformingLazyColumnState()
    if (edgeButton == null) {
        ScreenScaffold(scrollState = listState) { padding ->
            TransformingLazyColumn(state = listState, contentPadding = padding, content = content)
        }
    } else {
        ScreenScaffold(scrollState = listState, edgeButton = { edgeButton() }) { padding ->
            TransformingLazyColumn(state = listState, contentPadding = padding, content = content)
        }
    }
}

@Composable
private fun IdleScreen(onRecord: () -> Unit, onHistory: () -> Unit) {
    ListScreen(edgeButton = null) {
        item {
            Column(Modifier.fillMaxWidth().padding(top = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                FilledIconButton(onClick = onRecord, modifier = Modifier.size(80.dp)) {
                    Icon(painterResource(R.drawable.ic_mic), contentDescription = stringResource(R.string.record), Modifier.size(40.dp))
                }
            }
        }
        item {
            Text(
                stringResource(R.string.tap_to_dictate),
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        item { SecondaryAction(stringResource(R.string.history), onHistory) }
    }
}

@Composable
private fun RecordingScreen(startedAtElapsed: Long, onStop: () -> Unit, onCancel: () -> Unit) {
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(startedAtElapsed) {
        while (true) {
            now = SystemClock.elapsedRealtime()
            delay(250)
        }
    }
    val elapsedSeconds = ((now - startedAtElapsed) / 1000).coerceAtLeast(0)
    // No edge button here: Stop is the one thing to do, so it gets the centre of the screen.
    ListScreen(edgeButton = null) {
        item {
            Text(
                "%d:%02d".format(elapsedSeconds / 60, elapsedSeconds % 60),
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.displayMedium,
            )
        }
        item {
            Text(
                stringResource(R.string.max_length),
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        item {
            Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                FilledIconButton(onClick = onStop, modifier = Modifier.size(72.dp)) {
                    Icon(painterResource(R.drawable.ic_stop), contentDescription = stringResource(R.string.stop), Modifier.size(32.dp))
                }
            }
        }
        item { SecondaryAction(stringResource(R.string.cancel), onCancel) }
    }
}

/** Small tonal pill for the less important action on a screen (Cancel, Discard, Retry). */
@Composable
internal fun SecondaryAction(label: String, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        CompactButton(onClick = onClick, colors = ButtonDefaults.filledTonalButtonColors(), label = { Text(label) })
    }
}

@Composable
private fun ProgressScreen(label: String) {
    ListScreen(edgeButton = null) {
        item {
            Column(
                Modifier.fillMaxWidth().padding(top = 40.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                CircularProgressIndicator(Modifier.size(48.dp))
                Text(label, textAlign = TextAlign.Center)
            }
        }
    }
}

@Composable
private fun ReviewScreen(review: UiState.Review, onToggle: (Int) -> Unit, onCreate: () -> Unit, onDiscard: () -> Unit) {
    val count = review.selected.size
    val today = LocalDate.now()
    ListScreen(
        edgeButton = {
            EdgeButton(onClick = onCreate, enabled = count > 0) {
                Text(pluralStringResource(R.plurals.create_tasks, count, count))
            }
        },
    ) {
        item { ListHeader { Text(pluralStringResource(R.plurals.tasks_heard, review.tasks.size, review.tasks.size)) } }
        itemsIndexed(review.tasks) { index, task ->
            // Show everything that will be sent: date, any priority, and notes (truncated on the small screen).
            val priority = when (task.priority) {
                5 -> "High"
                3 -> "Medium"
                1 -> "Low"
                else -> null
            }
            val meta = listOfNotNull(task.due?.let { dueLabel(it, today) }, priority).joinToString(" · ")
            val secondary = listOf(meta, task.notes.orEmpty()).filter { it.isNotEmpty() }.joinToString("\n")
            CheckboxButton(
                checked = index in review.selected,
                onCheckedChange = { onToggle(index) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text(task.title, maxLines = 3) },
                secondaryLabel = if (secondary.isEmpty()) null else ({ Text(secondary, maxLines = 4, overflow = TextOverflow.Ellipsis) }),
            )
        }
        item { SecondaryAction(stringResource(R.string.discard), onDiscard) }
    }
}

@Composable
private fun DoneScreen(done: UiState.Done, onRetry: () -> Unit, onDone: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    LaunchedEffect(done) {
        haptics.performHapticFeedback(if (done.failed.isEmpty()) HapticFeedbackType.Confirm else HapticFeedbackType.Reject)
    }
    ListScreen(edgeButton = { EdgeButton(onClick = onDone) { Text(stringResource(R.string.done)) } }) {
        item {
            Text(
                pluralStringResource(R.plurals.created_tasks, done.created, done.created),
                modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.titleMedium,
            )
        }
        if (done.failed.isNotEmpty()) {
            item {
                Text(
                    pluralStringResource(R.plurals.failed_tasks, done.failed.size, done.failed.size),
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Center,
                )
            }
            item { SecondaryAction(stringResource(R.string.retry), onRetry) }
        }
    }
}

@Composable
private fun MessageScreen(message: String, action: String, onAction: () -> Unit, onDismiss: (() -> Unit)? = null) {
    ListScreen(edgeButton = { EdgeButton(onClick = onAction) { Text(action) } }) {
        item {
            Text(
                message,
                modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.titleSmall,
            )
        }
        if (onDismiss != null) {
            item { SecondaryAction(stringResource(R.string.cancel), onDismiss) }
        }
    }
}

/** "Today 10:00", "Tomorrow", "Thu 19 Nov 18:00" for the Worker's local `due` values. */
internal fun dueLabel(due: String, today: LocalDate): String {
    val date = LocalDate.parse(due.take(10))
    val day = when (date) {
        today -> "Today"
        today.plusDays(1) -> "Tomorrow"
        else -> date.format(DateTimeFormatter.ofPattern("EEE d MMM"))
    }
    return if (due.length > 10) "$day ${due.substring(11)}" else day
}
