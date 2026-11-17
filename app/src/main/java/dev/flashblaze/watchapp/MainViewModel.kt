package dev.flashblaze.watchapp

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import java.io.IOException
import java.time.ZoneId

sealed interface UiState {
    data object Idle : UiState
    data class Recording(val startedAtElapsed: Long) : UiState
    data object Uploading : UiState
    data class Review(val transcript: String, val tasks: List<Task>, val selected: Set<Int>) : UiState
    data object Creating : UiState
    data class Done(val created: Int, val failed: List<Task>) : UiState
    /** Recognized nothing worth reviewing; offer to record again. */
    data class NothingHeard(val message: String) : UiState
    data class Error(val message: String, val retry: Retry) : UiState
    data object MicPermissionDenied : UiState
}

enum class Retry { Upload, Create, RecordAgain }

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val api = TasksApi(BuildConfig.WORKER_URL, BuildConfig.APP_TOKEN)
    private val _state = MutableStateFlow<UiState>(UiState.Idle)
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** Kept until tasks are created, so a failed upload retries without re-recording. */
    private var audio: File? = null

    /** Tasks the user confirmed; on partial failure, only the failed ones. */
    private var pending: List<Task> = emptyList()

    init {
        // The recorder outlives this screen (screen off, activity recreated); resume from its state.
        viewModelScope.launch {
            Recorder.state.collect { recorder ->
                when (recorder) {
                    is RecorderState.Recording -> _state.value = UiState.Recording(recorder.startedAtElapsed)
                    is RecorderState.Finished -> {
                        Recorder.state.value = RecorderState.Idle
                        audio = recorder.file
                        upload()
                    }
                    is RecorderState.Failed -> {
                        Recorder.state.value = RecorderState.Idle
                        _state.value = UiState.Error(recorder.reason, Retry.RecordAgain)
                    }
                    RecorderState.Idle -> if (_state.value is UiState.Recording) _state.value = UiState.Idle
                }
            }
        }
    }

    fun record() {
        if (BuildConfig.WORKER_URL.isBlank() || BuildConfig.APP_TOKEN.isBlank()) {
            _state.value = UiState.Error("Set voiceTasks.workerUrl and voiceTasks.appToken in local.properties", Retry.RecordAgain)
            return
        }
        discardAudio()
        RecorderService.start(getApplication())
    }

    fun stopRecording() = RecorderService.stop(getApplication())

    fun cancelRecording() = RecorderService.cancel(getApplication())

    fun micPermissionDenied() {
        _state.value = UiState.MicPermissionDenied
    }

    fun toggle(index: Int) {
        val review = _state.value as? UiState.Review ?: return
        val selected = if (index in review.selected) review.selected - index else review.selected + index
        _state.value = review.copy(selected = selected)
    }

    fun upload() {
        val file = audio ?: return reset()
        _state.value = UiState.Uploading
        viewModelScope.launch {
            _state.value = try {
                val extraction = api.extract(file, ZoneId.systemDefault().id)
                if (extraction.tasks.isEmpty()) {
                    UiState.NothingHeard("No tasks heard")
                } else {
                    UiState.Review(extraction.transcript, extraction.tasks, extraction.tasks.indices.toSet())
                }
            } catch (e: ApiException) {
                if (e.code == "no_speech") UiState.NothingHeard("No speech heard") else UiState.Error(errorMessage(e), Retry.Upload)
            } catch (e: IOException) {
                UiState.Error(errorMessage(e), Retry.Upload)
            }
        }
    }

    fun createSelected() {
        val review = _state.value as? UiState.Review ?: return
        pending = review.tasks.filterIndexed { i, _ -> i in review.selected }
        if (pending.isNotEmpty()) create()
    }

    /** Creates [pending]; on partial failure keeps only the failed tasks so a retry never duplicates. */
    fun create() {
        _state.value = UiState.Creating
        viewModelScope.launch {
            _state.value = try {
                val result = api.createTasks(ZoneId.systemDefault().id, pending)
                val failedTitles = result.failed.map { it.title }.toSet()
                pending = pending.filter { it.title in failedTitles }
                if (pending.isEmpty()) discardAudio()
                UiState.Done(result.created.size, pending)
            } catch (e: ApiException) {
                UiState.Error(errorMessage(e), Retry.Create)
            } catch (e: IOException) {
                UiState.Error(errorMessage(e), Retry.Create)
            }
        }
    }

    fun reset() {
        discardAudio()
        pending = emptyList()
        _state.value = UiState.Idle
    }

    private fun discardAudio() {
        audio?.delete()
        audio = null
    }

    private fun errorMessage(e: Exception): String = when {
        e is IOException -> "No connection"
        e !is ApiException -> "Something went wrong"
        e.code == "ticktick_auth_expired" -> "TickTick login expired. Run bun run auth in worker/"
        e.code == "unauthorized" -> "Worker rejected the app token"
        e.code == "too_large" -> "Recording too large"
        else -> "Server error (${e.code})"
    }
}
