document.getElementById('messageForm').addEventListener('submit', function(event) {
    event.preventDefault();  // Prevent default form submission

    const formData = new FormData(this);  // Create FormData from the form

    fetch('/sendMessage', {
        method: 'POST',
        body: formData  // Send form data (text + image)
    })
    .then(response => response.json())
    .then(data => {
        console.log('Response:', data);
        document.getElementById('successMessage').innerText = 'Message sent successfully!';
        document.getElementById('successMessage').style.display = 'block';
    })
    .catch(error => {
        console.error('Error:', error);
        document.getElementById('errorMessage').innerText = 'Error sending message.';
        document.getElementById('errorMessage').style.display = 'block';
    });
});

// Image preview functionality
document.getElementById('imageInput').addEventListener('change', function(event) {
    const file = event.target.files[0];
    const previewContainer = document.getElementById('imagePreview');

    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const image = new Image();
            image.src = e.target.result;
            previewContainer.innerHTML = '';  // Clear previous preview
            previewContainer.appendChild(image);  // Display the new image
        };
        reader.readAsDataURL(file);
    } else {
        previewContainer.innerHTML = '';  // Clear the preview if no file is selected
    }
});
