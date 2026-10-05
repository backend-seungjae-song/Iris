param(
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [Parameter(Mandatory = $true)][string]$DestinationPath,
  [Parameter(Mandatory = $true)][int]$Width,
  [Parameter(Mandatory = $true)][int]$MaximumBytes
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$image = $null
try {
  $image = [System.Drawing.Image]::FromFile($SourcePath)
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  foreach ($scale in @(1, 0.85, 0.7, 0.55)) {
    $targetWidth = [Math]::Max(240, [int][Math]::Round($Width * $scale))
    $targetHeight = [Math]::Max(1, [int][Math]::Round($image.Height * $targetWidth / $image.Width))
    $bitmap = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight)
    $graphics = $null
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.Clear([System.Drawing.Color]::White)
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($image, 0, 0, $targetWidth, $targetHeight)
      foreach ($quality in @(78, 68, 58, 48)) {
        $parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
        try {
          $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
          $bitmap.Save($DestinationPath, $codec, $parameters)
        } finally { $parameters.Dispose() }
        if ((Get-Item -LiteralPath $DestinationPath).Length -le $MaximumBytes) { exit 0 }
      }
    } finally {
      if ($graphics) { $graphics.Dispose() }
      $bitmap.Dispose()
    }
  }
  exit 2
} finally {
  if ($image) { $image.Dispose() }
}
