package app.floatphone.shell

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import org.json.JSONArray
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 端上唤醒词检测（对标 Operit PersonalWakeListener 的简化自研实现）：
 * AudioRecord 采 16k 单声道 PCM → 能量 VAD 分段（RMS + 噪声底 EMA）→
 * MFCC(13)+Δ+ΔΔ=39 维特征 → DTW 与登记模板匹配，相似度超阈值触发。
 * 全程端上计算，不占在线识别；模板经 SharedPreferences 持久化。
 */
class WakeWordDetector(
    private val context: Context,
    private val onTriggered: (similarity: Float) -> Unit,
) {
    companion object {
        private const val PREFS = "hw_wakeword_templates"
        private const val KEY_TEMPLATES = "templates"
        const val FEATURE_DIM = 39

        fun loadTemplates(context: Context): List<FloatArray> {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_TEMPLATES, "") ?: ""
            if (raw.isBlank()) return emptyList()
            return runCatching {
                val arr = JSONArray(raw)
                val out = ArrayList<FloatArray>()
                for (i in 0 until arr.length()) {
                    val bytes = Base64.decode(arr.getString(i), Base64.DEFAULT)
                    val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
                    val f = FloatArray(bytes.size / 4)
                    for (j in f.indices) f[j] = buf.getFloat()
                    if (f.isNotEmpty() && f.size % FEATURE_DIM == 0) out.add(f)
                }
                out
            }.getOrElse { emptyList() }
        }

        fun saveTemplates(context: Context, templates: List<FloatArray>) {
            val arr = JSONArray()
            for (t in templates) {
                val bytes = ByteArray(t.size * 4)
                val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
                for (v in t) buf.putFloat(v)
                arr.put(Base64.encodeToString(bytes, Base64.NO_WRAP))
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_TEMPLATES, arr.toString()).apply()
        }
    }

    data class Config(
        val sampleRate: Int = 16000,
        val frameSize: Int = 512,
        val maxSegmentMs: Long = 1600L,
        val minSegmentMs: Long = 250L,
        val endSilenceMs: Long = 350L,
        val similarityThreshold: Float = 0.86f,
        val minRms: Float = 0.003f,
        val noiseRmsEmaAlpha: Float = 0.05f,
    )

    @Volatile
    private var running = false

    fun stop() {
        running = false
    }

    fun runLoop(config: Config = Config()) {
        if (running) return
        running = true
        val minBuf = AudioRecord.getMinBufferSize(
            config.sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val record = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            config.sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            max(minBuf, config.frameSize * 2),
        )
        val buffer = ShortArray(config.frameSize)
        val segment = ArrayList<Short>()
        var seenSpeech = false
        var speechMs = 0L
        var silenceMs = 0L
        var noiseRmsEma = 0f
        try {
            record.startRecording()
            while (running) {
                val read = record.read(buffer, 0, buffer.size)
                if (read <= 0) continue
                val isSpeech = read == config.frameSize && isSpeechFrame(buffer, config, noiseRmsEma)
                val chunkMs = read * 1000L / config.sampleRate
                if (!isSpeech && !seenSpeech) {
                    val frameRms = computeRms(buffer, read)
                    noiseRmsEma = if (noiseRmsEma <= 0f) frameRms
                    else (1f - config.noiseRmsEmaAlpha) * noiseRmsEma + config.noiseRmsEmaAlpha * frameRms
                }
                if (isSpeech) {
                    seenSpeech = true
                    silenceMs = 0L
                    speechMs += chunkMs
                    for (i in 0 until read) segment.add(buffer[i])
                    if (speechMs >= config.maxSegmentMs) {
                        flushSegment(config, segment, speechMs, noiseRmsEma)
                        segment.clear(); seenSpeech = false; speechMs = 0L; silenceMs = 0L
                    }
                } else if (seenSpeech) {
                    silenceMs += chunkMs
                    if (silenceMs >= config.endSilenceMs) {
                        flushSegment(config, segment, speechMs, noiseRmsEma)
                        segment.clear(); seenSpeech = false; speechMs = 0L; silenceMs = 0L
                    }
                }
            }
        } catch (_: Exception) {
            // 麦克风被占用/权限丢失：静默退出，网页可再次启动
        } finally {
            runCatching { record.stop() }
            runCatching { record.release() }
            running = false
        }
    }

    private fun flushSegment(config: Config, segment: ArrayList<Short>, speechMs: Long, noiseRms: Float) {
        if (segment.isEmpty()) return
        if (speechMs < config.minSegmentMs) return
        val templates = loadTemplates(context)
        if (templates.isEmpty()) return
        val pcm = ShortArray(segment.size)
        for (i in pcm.indices) pcm[i] = segment[i]
        val rms = computeRms(pcm)
        if (rms < max(config.minRms, noiseRms + 0.001f)) return
        val feat = extractFeatures(pcm)
        if (feat.isEmpty() || feat.size % FEATURE_DIM != 0) return
        val valid = templates.filter { it.size % FEATURE_DIM == 0 }
        if (valid.isEmpty()) return
        val featSeq = reshape(feat)
        var best = -1f
        for (t in valid) {
            val sim = dtwSimilarity(featSeq, reshape(t), 4)
            if (sim > best) best = sim
        }
        if (best >= config.similarityThreshold) {
            onTriggered(best)
        }
    }

    // ── 能量 VAD ──
    private fun isSpeechFrame(pcm: ShortArray, config: Config, noiseRms: Float): Boolean {
        val rms = computeRms(pcm)
        val gate = max(config.minRms, noiseRms + 0.001f)
        return rms >= gate
    }

    private fun computeRms(pcm: ShortArray): Float {
        return computeRms(pcm, pcm.size)
    }

    private fun computeRms(pcm: ShortArray, len: Int): Float {
        if (pcm.isEmpty() || len <= 0) return 0f
        var sum = 0.0
        val n = min(len, pcm.size)
        for (i in 0 until n) {
            val v = pcm[i].toDouble() / 32768.0
            sum += v * v
        }
        return sqrt((sum / n)).toFloat()
    }

    // ── MFCC 特征（13 + Δ + ΔΔ，帧长 400 / 帧移 160 / FFT 512 / mel 40）──
    fun extractFeatures(pcm: ShortArray): FloatArray {
        val sampleRate = 16000
        val frameSize = 400
        val hopSize = 160
        val fftSize = 512
        val melBins = 40
        val numMfcc = 13
        val maxFrames = 64

        val normalized = FloatArray(pcm.size) { pcm[it] / 32768f }
        val waveform = if (normalized.size > sampleRate * 2) normalized.copyOfRange(0, sampleRate * 2) else normalized
        if (waveform.size < frameSize) return FloatArray(0)

        // 分帧
        val frameCount = (waveform.size - frameSize) / hopSize + 1
        val limited = min(frameCount, maxFrames)
        val frames = ArrayList<FloatArray>(limited)
        for (t in 0 until limited) {
            val off = t * hopSize
            val frame = FloatArray(frameSize)
            for (i in 0 until frameSize) {
                var v = waveform[off + i]
                // 预加重 0.97
                if (i > 0) v -= 0.97f * waveform[off + i - 1]
                // Hann 窗
                v *= 0.5f * (1f - cos(2.0 * Math.PI * i / (frameSize - 1)).toFloat())
                frame[i] = v
            }
            frames.add(frame)
        }
        if (frames.isEmpty()) return FloatArray(0)

        // mel 滤波器组
        val mel = buildMelFilterBank(fftSize, sampleRate, melBins, 20f, 4000f)

        // 每帧 → log-mel
        val logMels = ArrayList<FloatArray>(frames.size)
        for (frame in frames) {
            val mag2 = fftMagSquared(frame, fftSize)
            val feats = FloatArray(melBins)
            for (i in 0 until melBins) {
                var sum = 0f
                val w = mel[i]
                val n = min(w.size, mag2.size)
                for (k in 0 until n) sum += w[k] * mag2[k]
                feats[i] = ln(max(1e-10f, sum))
            }
            logMels.add(feats)
        }

        // DCT → MFCC
        val cosTable = FloatArray(numMfcc * melBins) { idx ->
            val m = idx / melBins
            val b = idx % melBins
            cos(Math.PI * m * (b + 0.5) / melBins).toFloat()
        }
        val mfcc = Array(logMels.size) { FloatArray(numMfcc) }
        for (t in logMels.indices) {
            val frame = logMels[t]
            for (m in 0 until numMfcc) {
                var sum = 0f
                for (b in 0 until melBins) sum += frame[b] * cosTable[m * melBins + b]
                mfcc[t][m] = sum
            }
        }

        // Δ 与 ΔΔ
        val delta = computeDelta(mfcc)
        val delta2 = computeDelta(delta)

        // 拼接 39 维
        val featSeq = Array(mfcc.size) { FloatArray(FEATURE_DIM) }
        for (t in mfcc.indices) {
            for (i in 0 until numMfcc) {
                featSeq[t][i] = mfcc[t][i]
                featSeq[t][numMfcc + i] = delta[t][i]
                featSeq[t][numMfcc * 2 + i] = delta2[t][i]
            }
            l2NormalizeInPlace(featSeq[t])
        }

        val out = FloatArray(featSeq.size * FEATURE_DIM)
        var idx = 0
        for (t in featSeq.indices) for (i in 0 until FEATURE_DIM) out[idx++] = featSeq[t][i]
        return out
    }

    private fun buildMelFilterBank(fftSize: Int, sampleRate: Int, melBins: Int, fMin: Float, fMax: Float): Array<FloatArray> {
        fun hzToMel(hz: Float) = 2595f * ln(1f + hz / 700f)
        fun melToHz(mel: Float) = 700f * (exp(mel / 1125f) - 1f)
        val melMin = hzToMel(fMin)
        val melMax = hzToMel(fMax)
        val nyquist = fftSize / 2
        val points = FloatArray(melBins + 2)
        for (i in points.indices) {
            val mel = melMin + (melMax - melMin) * i / (melBins + 1)
            points[i] = melToHz(mel) * fftSize / sampleRate
        }
        val banks = Array(melBins) { FloatArray(nyquist + 1) }
        for (m in 0 until melBins) {
            val left = points[m]
            val center = points[m + 1]
            val right = points[m + 2]
            for (k in 0..nyquist) {
                val f = k.toFloat()
                val w = when {
                    f < left || f > right -> 0f
                    f < center -> (f - left) / max(1e-6f, center - left)
                    else -> (right - f) / max(1e-6f, right - center)
                }
                banks[m][k] = w
            }
        }
        return banks
    }

    private fun fftMagSquared(x: FloatArray, fftSize: Int): FloatArray {
        val n = fftSize
        val re = FloatArray(n)
        val im = FloatArray(n)
        for (i in x.indices) re[i] = x[i]
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while ((j and bit) != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j xor bit
            if (i < j) {
                val tr = re[i]; re[i] = re[j]; re[j] = tr
                val ti = im[i]; im[i] = im[j]; im[j] = ti
            }
        }
        var len = 2
        while (len <= n) {
            val ang = -2.0 * Math.PI / len
            val wRe = cos(ang).toFloat()
            val wIm = sin(ang).toFloat()
            var i = 0
            while (i < n) {
                var curRe = 1f
                var curIm = 0f
                for (k in 0 until len / 2) {
                    val a = i + k
                    val b = i + k + len / 2
                    val tRe = curRe * re[b] - curIm * im[b]
                    val tIm = curRe * im[b] + curIm * re[b]
                    re[b] = re[a] - tRe
                    im[b] = im[a] - tIm
                    re[a] += tRe
                    im[a] += tIm
                    val nRe = curRe * wRe - curIm * wIm
                    val nIm = curRe * wIm + curIm * wRe
                    curRe = nRe
                    curIm = nIm
                }
                i += len
            }
            len *= 2
        }
        val out = FloatArray(n / 2 + 1)
        for (i in out.indices) out[i] = re[i] * re[i] + im[i] * im[i]
        return out
    }

    private fun computeDelta(x: Array<FloatArray>): Array<FloatArray> {
        val out = Array(x.size) { FloatArray(if (x[0].isEmpty()) 0 else x[0].size) }
        if (x.size < 2) return out
        for (t in x.indices) {
            for (i in x[t].indices) {
                val prev = if (t > 0) x[t - 1][i] else x[t][i]
                val next = if (t + 1 < x.size) x[t + 1][i] else x[t][i]
                out[t][i] = (next - prev) / 2f
            }
        }
        return out
    }

    private fun l2NormalizeInPlace(x: FloatArray) {
        var norm = 0f
        for (v in x) norm += v * v
        norm = sqrt(max(1e-10f, norm))
        for (i in x.indices) x[i] /= norm
    }

    // ── DTW ──
    private fun reshape(flat: FloatArray): Array<FloatArray> {
        val frames = flat.size / FEATURE_DIM
        val out = Array(frames) { FloatArray(FEATURE_DIM) }
        var idx = 0
        for (t in 0 until frames) {
            for (i in 0 until FEATURE_DIM) out[t][i] = flat[idx++]
            l2NormalizeInPlace(out[t])
        }
        return out
    }

    private fun dtwSimilarity(a: Array<FloatArray>, b: Array<FloatArray>, band: Int): Float {
        if (a.isEmpty() || b.isEmpty()) return 0f
        val n = a.size
        val m = b.size
        val bandW = max(band, abs(n - m))
        val dp = Array(n + 1) { FloatArray(m + 1) { Float.POSITIVE_INFINITY } }
        dp[0][0] = 0f
        for (i in 1..n) {
            val jStart = max(1, i - bandW)
            val jEnd = min(m, i + bandW)
            for (j in jStart..jEnd) {
                val cost = cosineDistance(a[i - 1], b[j - 1])
                val bestPrev = min(dp[i - 1][j], min(dp[i][j - 1], dp[i - 1][j - 1]))
                dp[i][j] = cost + bestPrev
            }
        }
        val norm = max(1f, (n + m).toFloat())
        val avgCost = dp[n][m] / norm
        return (1f - avgCost / 2f).coerceIn(0f, 1f)
    }

    private fun cosineDistance(x: FloatArray, y: FloatArray): Float {
        val n = min(x.size, y.size)
        var dot = 0f
        var nx = 0f
        var ny = 0f
        for (i in 0 until n) {
            dot += x[i] * y[i]
            nx += x[i] * x[i]
            ny += y[i] * y[i]
        }
        val denom = sqrt(max(1e-10f, nx)) * sqrt(max(1e-10f, ny))
        return 1f - (dot / denom).coerceIn(-1f, 1f)
    }

    private fun exp(v: Float): Float = kotlin.math.exp(v)
}
