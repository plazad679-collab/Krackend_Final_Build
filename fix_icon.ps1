Add-Type -AssemblyName System.Drawing

function New-IcoFromPng {
    param(
        [string]$PngPath,
        [string]$IcoPath
    )
    $img = [System.Drawing.Image]::FromFile($PngPath)
    
    # Force resize to 256x256
    $resized = new-object System.Drawing.Bitmap 256, 256
    $graph = [System.Drawing.Graphics]::FromImage($resized)
    $graph.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graph.DrawImage($img, 0, 0, 256, 256)
    
    $ms = New-Object System.IO.MemoryStream
    $resized.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes = $ms.ToArray()
    
    $img.Dispose()
    $resized.Dispose()
    $graph.Dispose()
    $ms.Dispose()

    # ICO Header (6 bytes: 0,0, 1,0, 1,0)
    # 0-1: Reserved
    # 2-3: Type (1 for icon)
    # 4-5: Number of images
    $header = [byte[]](0, 0, 1, 0, 1, 0)
    
    # ICO Directory Entry (16 bytes)
    $entry = New-Object byte[] 16
    $entry[0] = 0 # Width (0 means 256)
    $entry[1] = 0 # Height (0 means 256)
    $entry[2] = 0 # Colors
    $entry[3] = 0 # Reserved
    $entry[4] = 1 # Planes
    $entry[5] = 0
    $entry[6] = 32 # BPP
    $entry[7] = 0
    
    $size = $pngBytes.Length
    $entry[8] = $size -band 0xFF
    $entry[9] = ($size -shr 8) -band 0xFF
    $entry[10] = ($size -shr 16) -band 0xFF
    $entry[11] = ($size -shr 24) -band 0xFF
    
    $offset = 22 # 6 (header) + 16 (1 entry)
    $entry[12] = $offset -band 0xFF
    $entry[13] = ($offset -shr 8) -band 0xFF
    $entry[14] = ($offset -shr 16) -band 0xFF
    $entry[15] = ($offset -shr 24) -band 0xFF
    
    $fs = [System.IO.File]::Open($IcoPath, [System.IO.FileMode]::Create)
    $fs.Write($header, 0, $header.Length)
    $fs.Write($entry, 0, $entry.Length)
    $fs.Write($pngBytes, 0, $pngBytes.Length)
    $fs.Close()
}

$source = "C:\Users\david\.gemini\antigravity\scratch\Krackend_Final_Build\dist\logo.png"
$dest = "C:\Users\david\.gemini\antigravity\scratch\Krackend_Final_Build\dist\logo.ico"

Write-Host "Creating 256x256 ICO from $source..."
New-IcoFromPng -PngPath $source -IcoPath $dest
Write-Host "Done."
